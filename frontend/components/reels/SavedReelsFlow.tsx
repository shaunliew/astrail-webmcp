'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { captureSavedReel, getOrganizeStatus, listSavedReelCards, startOrganize, streamOrganize } from '@/lib/reels/api'
import type { OrganizeJob, OrganizeStreamEvent, SavedReelCard, SavedReelPlaceProof } from '@/lib/reels/backend-types'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { groupPlacesByCountry, type CountryTray } from '@/lib/reels/organize'
import { getAccessToken } from '@/lib/supabase/session'
import { generateTrip, streamGeneration } from '@/lib/trip/api'
import { canGenerate, toGenerateRequest, type BriefInput, type DraftInspirationItem } from '@/lib/trip/parse-inspiration'
import TripBriefForm from '@/components/create/TripBriefForm'
import TripBriefReview from '@/components/create/TripBriefReview'
import { useSharedMap } from '@/components/map/MapProvider'
import { relightDurationMs } from '@/components/map/relight'
import GenerationScene from '@/components/create/GenerationScene'
import SavedReelsInbox from './SavedReelsInbox'
import OrganizeGlobe from './OrganizeGlobe'
import CountryTrays from './CountryTrays'

type Phase = 'inbox' | 'organizing' | 'trays' | 'brief' | 'review' | 'generating'

const EMPTY_BRIEF: BriefInput = {
  destination_hint: '', start_date: '', end_date: '', origin_city: '', budget_level: '', preferences: '',
}

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
      .then((nextCards) => { if (activeRef.current && !cancelled) setCards(nextCards) })
      .catch(() => { /* the inbox remains usable for a first capture */ })
    return () => { cancelled = true; activeRef.current = false }
  }, [])

  useEffect(() => () => {
    organizeHandleRef.current?.cancel()
    generationHandleRef.current?.cancel()
    if (pollRef.current) clearInterval(pollRef.current)
  }, [])

  async function reloadCards() {
    const nextCards = await listSavedReelCards()
    if (activeRef.current) setCards(nextCards)
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
      setTrays(nextTrays)
      setSelectedPlaceIds([])
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
    } catch {
      if (activeRef.current) setPhase('brief')
    }
  }

  if (phase === 'organizing') return <OrganizeGlobe message={organizeMessage} />
  if (phase === 'trays') return <CountryTrays trays={trays} selectedPlaceIds={selectedPlaceIds} onToggle={(id) => setSelectedPlaceIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])} onPlan={() => setPhase('brief')} />
  if (phase === 'generating') return <GenerationScene tripId={tripId} events={events} />
  if (phase === 'brief') return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-6 bg-[var(--void)] p-6">
      <TripBriefForm brief={brief} onChange={setBrief} />
      <button type="button" onClick={() => setPhase('review')} disabled={!canGenerate(briefItems, brief)} className="type-label min-h-11 rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-4 text-xs uppercase tracking-wide text-[var(--starlight)] disabled:cursor-not-allowed disabled:opacity-40">Review trip brief</button>
    </main>
  )
  if (phase === 'review') return <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-6 bg-[var(--void)] p-6"><TripBriefReview items={briefItems} brief={brief} onBack={() => setPhase('brief')} onGenerate={handleGenerate} /></main>
  return (
    <div className="min-h-[100dvh] bg-[var(--void)]">
      {inboxMessage ? (
        <div className="mx-auto w-full max-w-4xl px-6 pt-6">
          <p role="alert" className="surface type-body border border-[var(--warn)] p-3 text-sm text-[var(--starlight)]">
            {inboxMessage}
          </p>
        </div>
      ) : null}
      <SavedReelsInbox cards={cards} onCapture={handleCapture} onOrganize={handleOrganize} />
    </div>
  )
}
