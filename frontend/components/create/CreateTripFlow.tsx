'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { generateTrip, streamGeneration } from '@/lib/trip/api'
import { getAccessToken } from '@/lib/supabase/session'
import {
  canGenerate, toGenerateRequest,
  type DraftInspirationItem, type BriefInput,
} from '@/lib/trip/parse-inspiration'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { classifyGenerateError, useEntitlement } from '@/lib/entitlement'
import TrialExhaustedCard from '@/components/entitlement/TrialExhaustedCard'
import SignOutButton from '@/components/auth/SignOutButton'
import InspirationTray from './InspirationTray'
import TripBriefForm from './TripBriefForm'
import TripBriefReview from './TripBriefReview'
import { useSharedMap } from '@/components/map/MapProvider'
import { relightDurationMs } from '@/components/map/relight'
import GenerationScene from './GenerationScene'

const EMPTY_BRIEF: BriefInput = {
  destination_hint: '', start_date: '', end_date: '',
  origin_city: '', budget_level: '', preferences: '',
}

function tripIdFromResult(content: string, fallback: string): string {
  try {
    const parsed = JSON.parse(content) as { trip_id?: string }
    return parsed.trip_id ?? fallback
  } catch {
    return fallback
  }
}

export default function CreateTripFlow() {
  const router = useRouter()
  const { setLightPreset } = useSharedMap()
  const [items, setItems] = useState<DraftInspirationItem[]>([])
  const [brief, setBrief] = useState<BriefInput>(EMPTY_BRIEF)
  const [phase, setPhase] = useState<'compose' | 'brief' | 'generating'>('compose')
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [tripId, setTripId] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // Post-hoc gate: a generation that raced past the pre-emptive check and got a 403
  // trial_exhausted flips this so the card replaces the affordance (belt-and-suspenders
  // for `isTrialExhausted`, which is the pre-emptive read).
  const [caughtTrialExhausted, setCaughtTrialExhausted] = useState(false)
  const ent = useEntitlement()
  const gated = ent.isTrialExhausted || caughtTrialExhausted
  const handleRef = useRef<{ cancel: () => void } | null>(null)
  const activeRef = useRef(true)

  // Mounted-guard: createTrip is async (network latency). If the component unmounts
  // while it is pending, we must NOT start the stream afterward — otherwise the cleanup
  // (which already ran) can never cancel it, and its callback would setState / navigate
  // on an unmounted component. `activeRef` is re-armed on mount so StrictMode's
  // mount→unmount→mount double-invoke leaves it true.
  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      handleRef.current?.cancel()
    }
  }, [])

  async function handleGenerate() {
    setPhase('generating')
    setEvents([])
    setSubmitError(null)
    try {
      const token = await getAccessToken()
      const { trip_id } = await generateTrip(toGenerateRequest(items, brief), token)
      if (!activeRef.current) return // unmounted during POST — do not start the stream
      setTripId(trip_id)
      handleRef.current = streamGeneration(
        trip_id,
        token,
        (event) => {
          if (!activeRef.current) return
          setEvents((prev) => [...prev, event])
          if (event.type === 'result') {
            // The signature moment. The map is the shell's, shared with the trip view,
            // so this transition carries across the navigation instead of dying with
            // this component.
            setLightPreset('dawn', relightDurationMs())
            handleRef.current?.cancel()
            router.push(`/app/trip/${tripIdFromResult(event.content, trip_id)}`)
          }
        },
        () => { if (activeRef.current) setEvents([]) },
        () => {
          // Dead-backend escape hatch (5 failed reconnects): the job is durable
          // server-side, so hand off to the trip page's generating/failed states
          // instead of spinning forever.
          if (activeRef.current) router.push(`/app/trip/${trip_id}`)
        },
      )
    } catch (err) {
      if (!activeRef.current) return
      setPhase('compose')
      // trial_exhausted → the card (single classifier, shared with the pre-emptive gate);
      // every other backend code (incl. the structured conflict_retry/409) surfaces its
      // verbatim message via ApiError extends Error.
      if (classifyGenerateError(err)) {
        setCaughtTrialExhausted(true)
        return
      }
      setSubmitError(err instanceof Error ? err.message : 'Could not start generation.')
    }
  }

  // Task-8 carry-forward: requestSeat() has no internal catch, so an unwrapped call would be
  // an unhandled rejection. Wrap it and give the failure a home in the flow's error surface.
  async function handleRequestSeat() {
    try {
      await ent.requestSeat()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not request a seat.')
    }
  }

  if (phase === 'generating') {
    return <GenerationScene tripId={tripId} events={events} />
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-8 bg-[var(--void)] p-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <h1 className="type-display text-3xl text-[var(--starlight)]">Plan a new trip</h1>
          <div className="flex items-center gap-4">
            <Link
              href="/app/trips"
              className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)] underline-offset-2 hover:underline"
            >
              My trips
            </Link>
            <SignOutButton />
          </div>
        </div>
        <p className="type-body text-sm text-[var(--muted)]">
          Paste the Reels that inspired you, add any must-visit places, and Astrail maps the route you actually take.
        </p>
      </header>

      {submitError ? (
        <p className="type-body text-xs text-[var(--fail)]" role="alert">{submitError}</p>
      ) : null}

      {gated ? (
        <TrialExhaustedCard
          seatRequested={ent.seatRequested}
          onRequestSeat={handleRequestSeat}
          requesting={ent.requesting}
          canonicalTripId={ent.canonicalTripId}
          canonicalTripLoading={ent.canonicalTripLoading}
        />
      ) : phase === 'compose' ? (
        <>
          <InspirationTray items={items} onChange={setItems} />
          <TripBriefForm brief={brief} onChange={setBrief} />

          <button
            type="button"
            onClick={() => setPhase('brief')}
            disabled={!canGenerate(items, brief)}
            className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-4 py-3 text-sm uppercase tracking-wide text-[var(--starlight)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            Review trip brief
          </button>
        </>
      ) : (
        <TripBriefReview
          items={items}
          brief={brief}
          onBack={() => setPhase('compose')}
          onGenerate={handleGenerate}
        />
      )}
    </main>
  )
}
