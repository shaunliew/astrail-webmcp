'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { captureSavedReel, getOrganizeStatus, listSavedReelCards, startOrganize, streamOrganize } from '@/lib/reels/api'
import {
  clearOrganizeFailure, clearOrganizeFailureFor, organizeJobs, retireOrganizeJobs,
  subscribeOrganizeJobs, trackOrganizeJob, type OrganizeJobsSnapshot,
} from '@/lib/reels/organize-jobs'
import type { OrganizeItemStatus, OrganizeJob, OrganizeStreamEvent, SavedReelCard, SavedReelPlaceProof } from '@/lib/reels/backend-types'
import { groupPlacesByCountry, type CountryTray } from '@/lib/reels/organize'
import { overlayLiveStatus, wasAlreadySaved } from '@/lib/reels/labels'
import { getAccessToken } from '@/lib/supabase/session'
import { generateTrip } from '@/lib/trip/api'
import { toGenerateRequest, type BriefInput, type DraftInspirationItem } from '@/lib/trip/parse-inspiration'
import { classifyGenerateError, useEntitlement } from '@/lib/entitlement'
import TrialExhaustedCard from '@/components/entitlement/TrialExhaustedCard'
import { useOptionalWebMcpRegistry } from '@/components/webmcp/WebMcpRegistry'
import { subscribeViewIntent, takeViewIntent } from '@/lib/webmcp/view-intent'
import { useOptionalGeneration } from '@/components/generation/GenerationProvider'
import GenerationScene from '@/components/create/GenerationScene'
import TraysScreen from './TraysScreen'
import OrganizeGlobe from './OrganizeGlobe'
import CountryTrays from './CountryTrays'
import PlanSheet from './PlanSheet'

type Phase = 'inbox' | 'organizing' | 'trays' | 'brief' | 'generating'

const EMPTY_BRIEF: BriefInput = {
  destination_hint: '', start_date: '', end_date: '', origin_city: '', budget_level: '', preferences: '',
}

// The backend GenerateTripRequest caps place_ids at 5 (api/schemas.py, max_length=5);
// enforce it in the picker so a 6th selection can't produce a terminal 422.
const MAX_PLACES = 5

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

/** Nothing adopted yet. A constant, so the first render is identical on the server and in the
 *  browser — the real set is read in an effect, once there is a browser to read it in. */
const NO_ORGANIZE_JOBS: OrganizeJobsSnapshot = { jobIds: [], failure: null }

// What the user is told when a run ends any way but complete. The shell navigates on SUCCESS only,
// so without these the wait screen is where the session ends. `unknown` is deliberately not worded
// as a failure: the job is durable and may well still land, and telling someone to start again
// spends their allowance on a trip they are about to get.
const RUN_FAILED_MESSAGE = 'Your trip could not be finished. You can try generating it again.'
const RUN_LOST_MESSAGE = 'We lost contact with your trip while it was being built. It may still finish — check your trips before starting another.'

export default function SavedReelsFlow() {
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
  /** The run THIS mount has watched build. See the hand-over branch at the bottom of the render. */
  const watchedRunRef = useRef<number | null>(null)

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
  /* SUBSCRIBED to, not owned. The set used to live in this component's state and arrive through
     an optional ref this component published — and both die on unmount, which is precisely what
     the terminal navigation does while the organize request is still in flight. The module owns
     it now (lib/reels/organize-jobs), so a job started while this page was elsewhere is picked up
     the moment it mounts. The ref is still published, so a caller that reaches for it lands in
     the same durable set rather than in a slot that is null half the time. */
  const [organize, setOrganize] = useState<OrganizeJobsSnapshot>(NO_ORGANIZE_JOBS)
  const [liveItems, setLiveItems] = useState<Record<string, OrganizeItemStatus>>({})
  useEffect(() => {
    const sync = () => setOrganize(organizeJobs())
    sync()
    return subscribeOrganizeJobs(sync)
  }, [])
  useEffect(() => {
    const slot = registry?.adoptOrganizeJob
    if (!slot) return
    slot.current = trackOrganizeJob
    return () => { slot.current = null }
  }, [registry])
  const toolJobIds = organize.jobIds

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
          retireOrganizeJobs(done)
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

  /* The standing failure, retired once some job has taken every reel it names — by whatever route.
     Without this the notice is permanent in the case that produces it most: an overlap 409 means
     the batch was refused BECAUSE another job was already reading one of these reels, so those
     reels are organized minutes later and a hand-cleared-only notice would still be sitting over
     them. Keyed on the CARDS, which is the record that actually knows.

     The test is `analysis_status !== 'not_analyzed'`, and it is deliberately about OWNERSHIP
     rather than about places. This notice says one thing — "we could not start an organize" — and
     any other status is a reel some job did take: 'queued' and 'processing' mean one has it now,
     'organized', 'location_not_found' and 'failed' mean one finished with it and the CARD now
     carries that outcome, including the bad ones. A reel that ends with no places is not this
     notice's business; it is the card's, and leaving the notice up would say something untrue
     about why.

     Every named reel must be FOUND and past `not_analyzed`. A missing card is not evidence of
     anything, and neither is a library that failed to load — `every` over zero cards is vacuously
     true, so the read must have succeeded before this can conclude anything at all. */
  useEffect(() => {
    const failure = organize.failure
    if (!failure || cardsStatus !== 'ready') return
    const status = new Map(cards.map((card) => [card.id, card.analysis_status]))
    const organized = failure.savedReelIds.every((id) => {
      const value = status.get(id)
      return value !== undefined && value !== 'not_analyzed'
    })
    if (organized) clearOrganizeFailure()
  }, [organize.failure, cards, cardsStatus])

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
    /* The post-run organize that failed is now being done by hand — but only if THESE are the
       reels it was owed. A different batch is no evidence that those were ever read, and dropping
       the notice for it would hide the one place the failure is visible. */
    clearOrganizeFailureFor(submittedIds)
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
  //
  // The same effect owns the way OUT of the wait screen. The shell navigates on success only, so
  // a failed result or a dead stream left `phase` on 'generating' and GenerationScene on screen
  // for the rest of the session, with no route back and nothing said about why.
  //
  // Read through a ref, and keyed on `status` alone — this is about the run's status CHANGING, not
  // about the phase. A retry sets the phase back to 'generating' while the DEAD run's terminal
  // status is still the current one; an effect that watched the phase too would fire there,
  // conclude the fresh run had already ended, and freeze the previous run's reason on screen — so
  // a second run that merely lost contact would be reported as a trip that died.
  const status = shellRun?.status
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  // Read the same way `phase` is, and for the same reason: the intent effect below has to judge
  // what is ON SCREEN from a subscription callback that outlives the render it was created in.
  const statusRef = useRef(status)
  statusRef.current = status
  useEffect(() => {
    if (status === 'complete' || status === 'failed') void entRef.current.refetch()
    if (status !== 'failed' && status !== 'unknown') return
    // The reason is set whatever phase this page is in. An AGENT-started run takes the viewport
    // from the inbox, the trays or mid-organize, and when it ends the takeover simply lifts —
    // dropping the user back where they were with nothing said. Routing the reason to PlanSheet
    // alone meant they saw it only if they happened to be in the brief.
    setGenerateError(status === 'failed' ? RUN_FAILED_MESSAGE : RUN_LOST_MESSAGE)
    // The phase moves only for OUR OWN wait screen. An agent-started run has a workflow
    // underneath it — trays, a selection, a half-filled brief — and yanking that to the brief
    // would cost the user work they never offered up.
    if (phaseRef.current === 'generating') setPhase('brief')
  }, [status])

  /**
   * This page is where an agent action lands — and taking the intent is how it says so.
   *
   * `save_reels` and `plan_trip_from_reels` ask the app to come here (GlobalTools pushes the
   * route) and then WAIT, because a tool that reports a save before the screen has moved is the
   * defect this whole channel exists to fix. Taking the intent releases them, and it only happens
   * once this component is mounted and rendering — which is the honest definition of "the page
   * has moved". Single use by construction, so a back-button return here cannot replay it.
   *
   * Both cases are covered on purpose: the take on mount is the user ARRIVING from another route,
   * the subscription is an intent raised while they were already standing here.
   *
   * ACKNOWLEDGING is unconditional; ACTING on it is not — and the two used to be the same thing,
   * which is the bug this branch exists for. Signed in on /app, "save these reels" saved them,
   * released the tool and moved nothing: the route was already right, so the take was the whole
   * of it and the user still had to find "Open" themselves. `save_reels` awaits this reveal
   * precisely so it cannot report a save the screen has not caught up with, and that promise was
   * being kept only from other routes.
   *
   * What it still deliberately does NOT do is touch `phase`. An intent that lands mid-flow can
   * only change anything by throwing that flow away: leaving the trays drops a picker there is no
   * route back to without re-organizing, leaving the brief loses dates typed nowhere else, and
   * leaving 'organizing' or 'generating' cancels the only thing that ever ends those screens. The
   * agent's save is not a reason to cost someone that. So the reveal is offered to exactly one
   * phase — 'inbox', the library's own screen, where there is no work to lose — and dropped
   * everywhere else. Dropped, never queued: a reveal that waited for the user to walk back would
   * open the Library minutes later with nothing they did to explain it.
   *
   * `status` is the half `phase` cannot see. An AGENT-started run leaves this page at 'inbox' for
   * the whole 60-180s it builds, with GenerationScene over the top — so a phase check alone would
   * honour a save raised mid-run and open the Library behind a screen nobody can see it through.
   */
  const [libraryReveals, setLibraryReveals] = useState(0)
  useEffect(() => {
    const acknowledge = () => {
      const intent = takeViewIntent()
      // Reason, not merely arrival: a generation asks for this page because the WAIT SCREEN
      // renders here, and it has its own way of taking the viewport (the shell run, below).
      if (intent?.reason !== 'saved-reels') return
      if (phaseRef.current !== 'inbox' || statusRef.current === 'generating') return
      setLibraryReveals((asked) => asked + 1)
    }
    acknowledge()
    return subscribeViewIntent(acknowledge)
  }, [])

  async function handleGenerate() {
    /* The lock is shared with the agent's `plan_trip_from_reels`, and it is TAKEN here rather
       than read. The old check left it free across the token fetch and the POST below, so a
       click and an approval could both pass it and land two real backend runs — each spending
       Apify and OpenAI credit, neither stopping the other. Hiding the button on the next render
       is not a concurrency guard, and neither is a question whose answer goes stale mid-await. */
    const reservation = shell?.reserve() ?? null
    if (shell && !reservation) {
      setGenerateError('A trip is already being built. Wait for it to finish, then try again.')
      return
    }
    setPhase('generating')
    setGenerateError(null)
    try {
      const token = await getAccessToken()
      const request = toGenerateRequest(briefItems, brief)
      const response = await generateTrip({ ...request, reel_urls: [], requested_places: [], place_ids: selectedPlaceIds }, token)
      // Committed before the mounted check, deliberately. The shell owns the stream, the event
      // history, the dawn relight and the navigation, and it outlives this page — so a user who
      // navigates away mid-POST still gets the trip they have already paid for. (`begin` refuses
      // on its own if the SHELL has gone, which is the case where nothing could render it.)
      reservation?.begin(response.trip_id)
    } catch (err) {
      // No backend job exists — hand the lock back before anything else, or every later
      // generation is blocked for the session.
      reservation?.release()
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

  /* The run's ending, rendered wherever the takeover put the user back down.

     FIXED, above everything. CountryTrays is a `fixed inset-0 z-50` overlay, so a notice in
     normal flow ahead of it is in the DOM and behind the map — present to a test, invisible to
     the person it is for. It has to sit above the screen it is reporting on.

     PlanSheet already shows this same message through its `error` prop, so the brief branch is
     deliberately not wrapped — one message, in one place, per screen. */
  const runNotice = generateError ? (
    <p
      role="alert"
      className="fixed left-1/2 top-4 z-[60] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3 text-center text-[13px] text-[color:var(--text-muted)] shadow-lg"
    >
      {generateError}
    </p>
  ) : null

  /* A generation in flight is the FIRST branch, ahead of every phase.
     `phase` is this page's own workflow; `shell.run` is the trip being built, whoever started it.
     The phase branches used to come first, so an agent-started run beginning while the user was
     in the trays or mid-organize never reached this check at all: the agent narrated a trip into
     chat beside a website showing an unrelated screen. Approval is what makes the takeover
     intentional, and nothing underneath is destroyed by it — trays, selection and brief are this
     component's own state and are still there when the run ends. */
  const waiting = shellRun?.status === 'generating' || phase === 'generating'

  /* ...and it stays up through the HAND-OVER, until the route actually moves.

     `router.push` is not the frame that replaces this page — the shell fires it from the result
     handler and Next then fetches the trip route, which is many frames away. The status flip that
     ends the run is committed immediately, so a branch keyed on 'generating' alone stopped
     rendering the wait screen while /app was still the route on screen, and this component fell
     straight through to the library underneath. That is the bounce through the home page the user
     reported: build → home → trip.

     `phase` hid it on the path this page starts itself (the exit effect leaves 'generating' alone
     on a success, so the branch above still held), which is exactly why it survived a first fix.
     A run this page did not start has no phase of its own: an AGENT-started run, and equally the
     user's own run after they navigate away and back mid-build, both sit at 'inbox' the whole time
     and bounced every time.

     Latched per mount, and only while the run was actually GENERATING here:
     - `run.status` never returns to idle, so a bare `=== 'complete'` would put the wait screen
       back on screen for good the moment the user pressed Back from the finished trip.
     - a NEW generation whose POST fails resets `phase` to 'brief' while the PREVIOUS run's
       'complete' is still the current status; latching on anything looser would strand that user
       on a wait screen for a trip that is already open.
     Success only — 'failed' and 'unknown' navigate nowhere, and SavedReelsFlow's exit effect
     above owns handing the page back with the reason. */
  if (shellRun?.status === 'generating') watchedRunRef.current = shellRun.runId
  const handingOver = shellRun?.status === 'complete'
    && shellRun.tripId !== null
    && watchedRunRef.current === shellRun.runId

  if (waiting || handingOver) {
    return <GenerationScene tripId={shellRun?.tripId ?? null} events={shellRun?.events ?? []} />
  }
  if (phase === 'organizing') return <>{runNotice}<OrganizeGlobe message={organizeMessage} /></>
  if (phase === 'trays') return (
    <>
      {runNotice}
      <CountryTrays trays={trays} selectedPlaceIds={selectedPlaceIds} maxSelected={MAX_PLACES} onToggle={(id) => setSelectedPlaceIds((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length < MAX_PLACES ? [...current, id] : current)} onPlan={() => setPhase('brief')} onBack={() => setPhase('inbox')} />
    </>
  )
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
  /* The library's one line of news, and the organize that failed behind the user's back is part
     of it. The message from what they just DID wins: it is about this second, while the standing
     failure is about a trip that finished minutes ago and stays until those reels are read. Both
     in one slot rather than two stacked alerts — the inbox has one place to look. */
  const inboxNotice = inboxMessage ?? organize.failure?.message ?? null

  return (
    <div>
      {runNotice}
      {inboxNotice ? (
        <p role="alert" className="mb-6 rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3 text-[13px] text-[color:var(--text-muted)]">
          {inboxNotice}
        </p>
      ) : null}
      {/* `revealLibrary` is the count of asks this page has honoured, not a flag: the user can
          close the Library between two saves, and the second one has to be able to open it
          again. WHETHER is decided above, where the phase is; WHAT to open is TraysScreen's. */}
      <TraysScreen cards={liveCards} cardsStatus={cardsStatus} onCapture={handleCapture} onOrganize={handleOrganize} onCreateTrail={onCreateTrail} revealLibrary={libraryReveals} />
    </div>
  )
}
