'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createTrip, streamGeneration } from '@/lib/trip/mock-api'
import {
  canGenerate, toGenerateRequest,
  type DraftInspirationItem, type BriefInput,
} from '@/lib/trip/parse-inspiration'
import type { StreamEvent } from '@/lib/trip/backend-types'
import InspirationTray from './InspirationTray'
import TripBriefForm from './TripBriefForm'
import GenerationProgress from './GenerationProgress'

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
  const [items, setItems] = useState<DraftInspirationItem[]>([])
  const [brief, setBrief] = useState<BriefInput>(EMPTY_BRIEF)
  const [phase, setPhase] = useState<'compose' | 'generating'>('compose')
  const [events, setEvents] = useState<StreamEvent[]>([])
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
    const { trip_id } = await createTrip(toGenerateRequest(items, brief))
    if (!activeRef.current) return // unmounted during createTrip — do not start the stream
    handleRef.current = streamGeneration(trip_id, (event) => {
      if (!activeRef.current) return
      setEvents((prev) => [...prev, event])
      if (event.type === 'result') {
        router.push(`/app/trip/${tripIdFromResult(event.content, trip_id)}`)
      }
    })
  }

  if (phase === 'generating') {
    return <GenerationProgress events={events} />
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-8 bg-[var(--void)] p-6">
      <header className="flex flex-col gap-1">
        <h1 className="type-display text-3xl text-[var(--starlight)]">Plan a new trip</h1>
        <p className="type-body text-sm text-[var(--muted)]">
          Paste the Reels that inspired you, add any must-visit places, and Astrail maps the route you actually take.
        </p>
      </header>

      <InspirationTray items={items} onChange={setItems} />
      <TripBriefForm brief={brief} onChange={setBrief} />

      <button
        type="button"
        onClick={handleGenerate}
        disabled={!canGenerate(items, brief)}
        className="type-label rounded-xl border border-[var(--brass)] bg-[var(--brass-soft)] px-4 py-3 text-sm uppercase tracking-wide text-[var(--starlight)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      >
        Generate my trip
      </button>
    </main>
  )
}
