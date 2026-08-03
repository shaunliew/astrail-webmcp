'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { captureSavedReel, getOrganizeStatus, listSavedReelCards, startOrganize, streamOrganize } from '@/lib/reels/api'
import type { OrganizeJob, OrganizeStreamEvent, SavedReelCard, SavedReelPlaceProof } from '@/lib/reels/backend-types'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { groupPlacesByCountry, type CountryTray } from '@/lib/reels/organize'
import { getAccessToken } from '@/lib/supabase/session'
import { generateTrip, streamGeneration } from '@/lib/trip/api'
import { toGenerateRequest, type BriefInput, type DraftInspirationItem } from '@/lib/trip/parse-inspiration'
import { classifyGenerateError, useEntitlement } from '@/lib/entitlement'
import TrialExhaustedCard from '@/components/entitlement/TrialExhaustedCard'
import { useSharedMap } from '@/components/map/MapProvider'
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

export default function SavedReelsFlow() {
  const router = useRouter()
  const { setLightPreset } = useSharedMap()
  const [phase, setPhase] = useState<Phase>('inbox')
  const [cards, setCards] = useState<SavedReelCard[]>([])
  const [jobId, setJobId] = useState<string | null>(null)
  const [organizeToken, setOrganizeToken] = useState<string | null>(null)
  const [organizeMessage, setOrganizeMessage] = useState('Preparing your selected Reels…')
  const [inboxMessage, setInboxMessage] = useState<string | null>(null)
  const [trays, setTrays] = useState<CountryTray[]>([])
  const [selectedPlaceIds, setSelectedPlaceIds] = useState<string[]>([])
  const [brief, setBrief] = useState<BriefInput>(EMPTY_BRIEF)
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [tripId, setTripId] = useState<string | null>(null)
  const [generateError, setGenerateError] = useState<string | null>(null)
  // Entitlement gate: the same hook + classifier as CreateTripFlow (single source, no logic
  // duplication). `caughtTrialExhausted` is the post-hoc 403 belt to the pre-emptive read.
  const ent = useEntitlement()
  const [caughtTrialExhausted, setCaughtTrialExhausted] = useState(false)
  const gated = ent.isTrialExhausted || caughtTrialExhausted
  // The saved-reel fetch state, forwarded to TraysScreen/TrayDetail so a tray with members
  // never reads as "0 reels" / "No reels yet" while the cards are still loading or failed (M3).
  const [cardsStatus, setCardsStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const activeRef = useRef(true)
  const submittedReelIdsRef = useRef<string[]>([])
  const organizeCursorRef = useRef<string | null>(null)
  const organizeHandleRef = useRef<{ cancel: () => void } | null>(null)
  const generationHandleRef = useRef<{ cancel: () => void } | null>(null)
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
    generationHandleRef.current?.cancel()
    if (pollRef.current) clearInterval(pollRef.current)
  }, [])

  async function reloadCards() {
    const nextCards = await listSavedReelCards()
    if (activeRef.current) { setCards(nextCards); setCardsStatus('ready') }
  }

  async function handleCapture(url: string) {
    setInboxMessage(null)
    const token = await getAccessToken()
    if (!activeRef.current) return
    await captureSavedReel(url, token)
    if (!activeRef.current) return
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

  async function handleGenerate() {
    setPhase('generating')
    setEvents([])
    setGenerateError(null)
    try {
      const token = await getAccessToken()
      const request = toGenerateRequest(briefItems, brief)
      const response = await generateTrip({ ...request, reel_urls: [], requested_places: [], place_ids: selectedPlaceIds }, token)
      if (!activeRef.current) return
      setTripId(response.trip_id)
      generationHandleRef.current = streamGeneration(
        response.trip_id,
        token,
        (event) => {
          if (!activeRef.current) return
          setEvents((current) => [...current, event])
          if (event.type === 'result') {
            // The signature moment — see CreateTripFlow: same live shell map, same beat.
            setLightPreset('dawn', relightDurationMs())
            generationHandleRef.current?.cancel()
            router.push(`/app/trip/${tripIdFromResult(event.content, response.trip_id)}`)
          }
        },
        () => { if (activeRef.current) setEvents([]) },
        () => { if (activeRef.current) router.push(`/app/trip/${response.trip_id}`) },
      )
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
  if (phase === 'generating') return <GenerationScene tripId={tripId} events={events} />
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
      <TraysScreen cards={cards} cardsStatus={cardsStatus} onCapture={handleCapture} onOrganize={handleOrganize} onCreateTrail={onCreateTrail} />
    </div>
  )
}
