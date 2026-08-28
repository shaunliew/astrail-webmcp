'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { captureSavedReel, getOrganizeStatus, listSavedReelCards, startOrganize, streamOrganize } from '@/lib/reels/api'
import type { OrganizeItemStatus, OrganizeJob, OrganizeStreamEvent, SavedReelCard, SavedReelPlaceProof } from '@/lib/reels/backend-types'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { groupPlacesByCountry, type CountryTray } from '@/lib/reels/organize'
import { overlayLiveStatus, wasAlreadySaved } from '@/lib/reels/labels'
import { getAccessToken } from '@/lib/supabase/session'
import { generateTrip, streamGeneration } from '@/lib/trip/api'
import { toGenerateRequest, type BriefInput, type DraftInspirationItem } from '@/lib/trip/parse-inspiration'
import { classifyGenerateError, useEntitlement } from '@/lib/entitlement'
import TrialExhaustedCard from '@/components/entitlement/TrialExhaustedCard'
import { useSharedMap } from '@/components/map/MapProvider'
import { useOptionalWebMcpRegistry } from '@/components/webmcp/WebMcpRegistry'
import { useOptionalGeneration } from '@/components/generation/GenerationProvider'
import { relightDurationMs } from '@/components/map/relight'
import GenerationScene from '@/components/create/GenerationScene'
import TraysScreen from './TraysScreen'
import OrganizeGlobe from './OrganizeGlobe'
import CountryTrays from './CountryTrays'
import PlanSheet from './PlanSheet'

type Phase = 'inbox' | 'organizing' | 'trays' | 'brief' | 'review' | 'generating'

const EMPTY_BRIEF: BriefInput = {
  destination_hint: '', start_date: '', end_date: '', origin_city: '', budget_level: '', preferences: '',
}

// The backend GenerateTripRequest caps place_ids at 5 (api/schemas.py, max_length=5);
// enforce it in the picker so a 6th selection can't produce a terminal 422.
const MAX_PLACES = 5

function tripIdFromResult(content: string, fallback: string): string {
  try { return (JSON.parse(content) as { trip_id?: string }).trip_id ?? fallback } catch { return fallback }
}

export function toReelBriefItem(place: SavedReelPlaceProof): DraftInspirationItem {
  return {
    key: `place:${place.place_id}`,
    item_type: 'reel_url',
    source: 'web_share_target',
    normalized_reel_url: place.source_reel_url,
    requested_place_text: null,
    status: 'places_found',
  }
}

/** Most adopted organize jobs followed at once. Real use adds one per `save_reels` call; the cap
 *  only bites on a job that never reaches a terminal status and so is never retired. */
const MAX_ADOPTED_JOBS = 8

export default function SavedReelsFlow() {
  const router = useRouter()
  const { setLightPreset } = useSharedMap()
  // Optional so this component still renders in tests and any shell without the provider.
  const shell = useOptionalGeneration()
  const shellRun = shell?.run
  const [phase, setPhase] = useState<Phase>('inbox')
  const [cards, setCards] = useState<SavedReelCard[]>([])
  const [jobId, setJobId] = useState<string | null>(null)
  const [organizeToken, setOrganizeToken] = useState<string | null>(null)
  const [organizeMessage, setOrganizeMessage] = useState('Preparing your selected Reels…')
  const [inboxMessage, setInboxMessage] = useState<string | null>(null)
  const [trays, setTrays] = useState<CountryTray[]>([])
  const [selectedPlaceIds, setSelectedPlaceIds] = useState<string[]>([])
  const [brief, setBrief] = useState<BriefInput>(EMPTY_BRIEF)
  const [generateError, setGenerateError] = useState<string | null>(null)
  // Entitlement gate: the same hook + classifier as CreateTripFlow (single source, no logic
  // duplication). `caughtTrialExhausted` is the post-hoc 403 belt to the pre-emptive read.
  const ent = useEntitlement()
  const [caughtTrialExhausted, setCaughtTrialExhausted] = useState(false)
  const entRef = useRef(ent)
  entRef.current = ent
  const gated = ent.isTrialExhausted || caughtTrialExhausted
  // The saved-reel fetch state, forwarded to TraysScreen/TrayDetail so a tray with members
  // never reads as "0 reels" / "No reels yet" while the cards are still loading or failed (M3).
  const [cardsStatus, setCardsStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const activeRef = useRef(true)
  const submittedReelIdsRef = useRef<string[]>([])
  const organizeCursorRef = useRef<string | null>(null)
  const organizeHandleRef = useRef<{ cancel: () => void } | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    activeRef.current = true
    let cancelled = false
    listSavedReelCards()
      .then((nextCards) => { if (activeRef.current && !cancelled) { setCards(nextCards); setCardsStatus('ready') } })
      .catch(() => { if (activeRef.current && !cancelled) setCardsStatus('error') /* the inbox remains usable for a first capture */ })
    return () => { cancelled = true; activeRef.current = false }
  }, [])

  useEffect(() => () => {
    organizeHandleRef.current?.cancel()
    if (pollRef.current) clearInterval(pollRef.current)
  }, [])

  async function reloadCards() {
    const nextCards = await listSavedReelCards()
    if (activeRef.current) { setCards(nextCards); setCardsStatus('ready') }
  }

  /* Publish this page's re-fetch so a tool can make the list catch up with what it just saved.
     Without it a reel saved by the agent existed only in the database: this component keeps
     rendering the cards it loaded on mount, so the reel appeared solely after a manual reload —
     which reads as the save having quietly failed. Same mechanism the trip page uses for edits. */
  const registry = useOptionalWebMcpRegistry()
  useEffect(() => {
    const slot = registry?.refreshSavedReels
    if (!slot) return
    slot.current = reloadCards
    return () => { slot.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry])

  /* Follow organize jobs an AGENT started.
     `saved_reels.analysis_status` is never 'queued' or 'processing' in practice: the organizer
     writes only a terminal value at the end, so a card read "Not analyzed" for the whole run.
     The obvious fix — write those two states — is worse than it looks. Nothing owns them: a job
     that fails between its steps marks only the parent job failed, stranding the reel reading
     "Analyzing…" forever, and an idempotent retry drags a reel that is genuinely processing back
     to "queued". So progress is DERIVED from the job, which is the record that actually knows.

     A SET of job ids, not one. The backend does NOT enforce one active organize job per user —
     the active unique index is on (user_id, idempotency_key), and creation rejects only jobs
     that OVERLAP an active job's saved reels. Two disjoint batches run happily side by side, so
     a second `save_reels` while the first is still extracting used to replace the first job and
     abandon it, leaving its cards stale until something unrelated refreshed them. */
  const [toolJobIds, setToolJobIds] = useState<string[]>([])
  const [liveItems, setLiveItems] = useState<Record<string, OrganizeItemStatus>>({})
  useEffect(() => {
    const slot = registry?.adoptOrganizeJob
    if (!slot) return
    // Bounded: a job is normally retired when it reaches a terminal status, but one that never
    // does (deleted, permanently unreadable) would otherwise be polled for the life of the page
    // and grow the batch forever. Oldest out — a stalled job is the least likely to still matter.
    slot.current = (id: string) => setToolJobIds((prev) => (
      prev.includes(id) ? prev : [...prev, id].slice(-MAX_ADOPTED_JOBS)
    ))
    return () => { slot.current = null }
  }, [registry])

  // Items whose refetch has ALREADY landed, keyed `jobId:reelId` — a reel re-analysed by a LATER
  // job must not be suppressed by the earlier job having settled it.
  const settledRef = useRef<Set<string>>(new Set())
  const jobKey = toolJobIds.join(',')
  useEffect(() => {
    if (toolJobIds.length === 0) return
    let stopped = false
    let inFlight = false
    const tick = async () => {
      // One tick at a time. A slow round of status reads would otherwise overlap the next
      // interval and double every request, exactly when the backend is already struggling.
      if (inFlight) return
      inFlight = true
      try {
        const token = await getAccessToken()
        /* allSettled, NOT all: one rejected status read used to reject the whole batch, so a
           single unreadable job id stalled EVERY adopted job for the rest of the page mount —
           and nothing evicts a permanently bad id. Each job now advances on its own. */
        const settled = await Promise.allSettled(toolJobIds.map((id) => getOrganizeStatus(id, token)))
        if (stopped || !activeRef.current) return
        const jobs = settled
          .filter((r): r is PromiseFulfilledResult<OrganizeJob> => r.status === 'fulfilled')
          .map((r) => r.value)
        if (jobs.length === 0) return          // every read failed; the next tick retries

        const items = jobs.flatMap((j) => j.items)
        setLiveItems(Object.fromEntries(items.map((i) => [i.saved_reel_id, i.status])))

        /* Refetch as each REEL lands, not only when its whole job does: a two-reel job finished
           its first reel while the second was still extracting, and that card had nowhere to get
           its real status and places from until the very end.

           An id is marked settled only AFTER its refetch succeeds. Marking it first meant a
           single failed read retired the item forever — reinstating the stale card this whole
           mechanism exists to prevent, and doing it invisibly. */
        const fresh = jobs.flatMap((j) => j.items
          .filter((i) => i.status !== 'queued' && i.status !== 'processing')
          .filter((i) => !settledRef.current.has(`${j.job_id}:${i.saved_reel_id}`))
          .map((i) => ({ key: `${j.job_id}:${i.saved_reel_id}`, item: i })))
        const finished = jobs.filter((j) => j.status === 'succeeded' || j.status === 'failed')

        if (fresh.length > 0 || finished.length > 0) {
          await reloadCards()                       // throws on failure -> nothing below runs
          for (const f of fresh) settledRef.current.add(f.key)
        }

        /* Drop a job only once its cards have actually been reloaded. Clearing state first and
           awaiting the reload afterwards meant one transient read failure stopped the poll for
           good: the effect was already disabled, its interval already cleared, and no retry left. */
        if (finished.length > 0) {
          const done = new Set(finished.map((j) => j.job_id))
          setToolJobIds((prev) => prev.filter((id) => !done.has(id)))
          setLiveItems((prev) => Object.fromEntries(
            Object.entries(prev).filter(([id]) => !finished.some((j) => j.items.some((i) => i.saved_reel_id === id))),
          ))
        }
      } catch {
        // Transient: the next tick retries, and nothing has been retired in the meantime.
      } finally {
        inFlight = false
      }
    }
    void tick()
    const id = setInterval(() => { void tick() }, 3000)
    return () => { stopped = true; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobKey])

  // Purely a view concern — nothing is written, so there is no state to strand and nothing to
  // reconcile. The rule itself lives in lib/reels/labels so it can be tested without a DOM.
  const liveCards = useMemo(() => overlayLiveStatus(cards, liveItems), [cards, liveItems])

  async function handleCapture(url: string) {
    setInboxMessage(null)
    const token = await getAccessToken()
    if (!activeRef.current) return
    const { saved_reel: saved } = await captureSavedReel(url, token)
    if (!activeRef.current) return
    // The RPC upserts, so a link the user already had came back looking exactly like a new save
    // and was reported as one. Telling someone they saved something they did not is a small lie
    // that costs them a real hunt for the "new" reel.
    setInboxMessage(wasAlreadySaved(saved) ? 'That reel is already in your library.' : null)
    await reloadCards()
  }

  async function handleOrganize(ids: string[]) {
    setInboxMessage(null)
    const submittedIds = [...ids]
    const token = await getAccessToken()
    if (!activeRef.current) return
    const result = await startOrganize(submittedIds, token)
    if (!activeRef.current) return
    submittedReelIdsRef.current = submittedIds
    setJobId(result.job_id)
    organizeCursorRef.current = null
    setOrganizeToken(token)
    setOrganizeMessage('Queued for organization…')
    setPhase('organizing')
  }

  useEffect(() => {
    if (phase !== 'organizing' || !jobId || !organizeToken) return
    let cancelled = false
    let finishInFlight = false

    const clearPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }

    const finish = async (status: OrganizeJob) => {
      if (cancelled || !activeRef.current || finishInFlight) return
      finishInFlight = true
      clearPolling()
      if (status.status === 'failed') {
        setInboxMessage(status.status_message || 'Organization failed. You can retry from the inbox.')
        setPhase('inbox')
        return
      }
      const nextCards = await listSavedReelCards()
      if (cancelled || !activeRef.current) return
      const submittedIds = new Set(submittedReelIdsRef.current)
      const submittedCards = nextCards.filter((card) => submittedIds.has(card.id))
      const nextTrays = groupPlacesByCountry(submittedCards.flatMap((card) => card.places))
      setCards(nextCards)
      setCardsStatus('ready')
      setTrays(nextTrays)
      setSelectedPlaceIds([])
      setGenerateError(null) // a fresh organize→trays run must not surface a prior attempt's generate error
      if (!nextTrays.length) {
        setInboxMessage('We could not verify any locations from those Reels. Nothing was pinned. Please retry from your inbox.')
        setPhase('inbox')
        return
      }
      setPhase('trays')
    }

    const refresh = async (): Promise<boolean> => {
      try {
        const status = await getOrganizeStatus(jobId, organizeToken)
        if (cancelled || !activeRef.current) return true
        setOrganizeMessage(status.status_message)
        const terminal = status.status === 'succeeded' || status.status === 'failed'
        if (terminal) await finish(status)
        return terminal
      } catch {
        if (!cancelled && activeRef.current) setOrganizeMessage('Reconnecting to your organization job…')
        return false
      }
    }

    const startPolling = () => {
      if (cancelled || !activeRef.current || pollRef.current) return
      pollRef.current = setInterval(() => { void refresh() }, 1000)
    }

    const refreshWithFallback = () => {
      void refresh().then((terminal) => { if (!terminal) startPolling() })
    }

    organizeHandleRef.current = streamOrganize(
      jobId,
      organizeToken,
      (event: OrganizeStreamEvent) => {
        if (cancelled || !activeRef.current) return
        if (event.type === 'stage') setOrganizeMessage(event.msg)
        if (event.type === 'warning' || event.type === 'error') setOrganizeMessage(event.msg)
        if (event.type === 'result') refreshWithFallback()
      },
      () => { if (!cancelled && activeRef.current) setOrganizeMessage('Reconnected — catching up with the durable job…') },
      () => {
        if (cancelled || !activeRef.current) return
        setOrganizeMessage('Reconnecting to your organization job…')
        startPolling()
        void refresh()
      },
      organizeCursorRef.current,
      (cursor) => { organizeCursorRef.current = cursor },
    )

    return () => {
      cancelled = true
      organizeHandleRef.current?.cancel()
      organizeHandleRef.current = null
      clearPolling()
    }
  }, [phase, jobId, organizeToken])

  const selectedPlaces = useMemo(
    () => trays.flatMap((tray) => tray.places).filter((place) => selectedPlaceIds.includes(place.place_id)),
    [trays, selectedPlaceIds],
  )
  const briefItems = useMemo<DraftInspirationItem[]>(() => selectedPlaces.map(toReelBriefItem), [selectedPlaces])

  // A terminal run refunds a failed generation in the same transaction that emitted the result,
  // so the entitlement gate must be re-read or it stays a generation behind. It used to happen
  // inline in the stream handler; the stream now belongs to the shell.
  const status = shellRun?.status
  useEffect(() => {
    if (status === 'complete' || status === 'failed') void entRef.current.refetch()
  }, [status])

  async function handleGenerate() {
    // The lock is shared with the agent's `plan_trip_from_reels`. Without it a click and an
    // approval land two real backend runs, each spending Apify and OpenAI credit, and neither
    // stops the other. Hiding the button on the next render is not a concurrency guard.
    if (shell && !shell.canStart()) {
      setGenerateError('A trip is already being built. Wait for it to finish, then try again.')
      return
    }
    setPhase('generating')
    setGenerateError(null)
    try {
      const token = await getAccessToken()
      const request = toGenerateRequest(briefItems, brief)
      const response = await generateTrip({ ...request, reel_urls: [], requested_places: [], place_ids: selectedPlaceIds }, token)
      if (!activeRef.current) return
      // The shell owns the stream, the event history, the dawn relight and the navigation — so a
      // run survives this page unmounting, and so the agent's run and this one are the same run.
      shell?.start(response.trip_id)
    } catch (err) {
      if (activeRef.current) {
        setPhase('brief')
        // trial_exhausted → the card; every other backend code (incl. the structured
        // conflict_retry/409) surfaces its verbatim message via ApiError extends Error.
        if (classifyGenerateError(err)) {
          setCaughtTrialExhausted(true)
          return
        }
        setGenerateError(err instanceof Error ? err.message : 'Could not start generating your trip.')
      }
    }
  }

  // Task-8 carry-forward: requestSeat() has no internal catch — wrap it so a rejection has a
  // home in the flow's error surface instead of becoming an unhandled rejection.
  async function handleRequestSeat() {
    try {
      await ent.requestSeat()
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Could not request a seat.')
    }
  }

  // Create-trail from an opened tray (T3.1b): route the tray's grounded places into the SAME
  // generate seam the organize path uses (CountryTrays ≤5 → PlanSheet → handleGenerate).
  // groupPlacesByCountry dedups by place_id. The empty guard is master B3 step-4 defense-in-depth:
  // TrayDetail's disabled button is the UX, but a stale/programmatic call must never enter an
  // empty, non-dismissible picker — so on no places we return without changing phase. Every tray
  // enters the picker with zero pre-selection; the user picks ≤5 (never auto-submit, master :268).
  function onCreateTrail(trayCards: SavedReelCard[]) {
    const nextTrays = groupPlacesByCountry(trayCards.flatMap((c) => c.places))
    if (!nextTrays.length) return
    setGenerateError(null) // don't carry a failed tray-A generate's error into tray B's brief (Codex)
    setTrays(nextTrays)
    setSelectedPlaceIds([])
    setPhase('trays')
  }

  if (phase === 'organizing') return <OrganizeGlobe message={organizeMessage} />
  if (phase === 'trays') return <CountryTrays trays={trays} selectedPlaceIds={selectedPlaceIds} maxSelected={MAX_PLACES} onToggle={(id) => setSelectedPlaceIds((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length < MAX_PLACES ? [...current, id] : current)} onPlan={() => setPhase('brief')} onBack={() => setPhase('inbox')} />
  // `phase` is this page's own workflow; `shell.run` is the trip being built, whoever started it.
  // Either one showing means the wait screen owns the viewport.
  if (phase === 'generating' || shellRun?.status === 'generating') {
    return <GenerationScene tripId={shellRun?.tripId ?? null} events={shellRun?.events ?? []} />
  }
  if (phase === 'brief') return (
    <PlanSheet
      places={selectedPlaces}
      reelCount={new Set(selectedPlaces.map((place) => place.source_reel_url)).size}
      brief={brief}
      onBrief={setBrief}
      onBack={() => setPhase('trays')}
      onGenerate={handleGenerate}
      error={generateError}
      gateSlot={gated ? (
        <TrialExhaustedCard
          seatRequested={ent.seatRequested}
          onRequestSeat={handleRequestSeat}
          requesting={ent.requesting}
          canonicalTripId={ent.canonicalTripId}
          canonicalTripLoading={ent.canonicalTripLoading}
        />
      ) : undefined}
    />
  )
  return (
    <div>
      {inboxMessage ? (
        <p role="alert" className="mb-6 rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3 text-[13px] text-[color:var(--text-muted)]">
          {inboxMessage}
        </p>
      ) : null}
      <TraysScreen cards={liveCards} cardsStatus={cardsStatus} onCapture={handleCapture} onOrganize={handleOrganize} onCreateTrail={onCreateTrail} />
    </div>
  )
}
