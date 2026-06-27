'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import ReelInputPanel, { type TripFormValues } from '@/components/trip/ReelInputPanel'
import GenerationTimeline from '@/components/trip/GenerationTimeline'
import { generateTrip, streamTrip } from '@/lib/trip/api'
import { parseSSEChunk } from '@/lib/trip/sse'
import type { StageEvent } from '@/lib/trip/backend-types'
import { createClient } from '@/lib/supabase/client'

export default function NewTripPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [stages, setStages] = useState<StageEvent[]>([])
  const [elapsed, setElapsed] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(values: TripFormValues) {
    setIsLoading(true)
    setStages([])
    setElapsed(null)
    setError(null)

    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.push('/sign-in')
        return
      }

      const { tripId } = await generateTrip(values, session.access_token)

      await new Promise<void>((resolve, reject) => {
        const es = streamTrip(tripId, session.access_token)

        es.onmessage = (e) => {
          if (e.data === '[DONE]') {
            es.close()
            resolve()
            router.push(`/app/trip/${tripId}`)
            return
          }
          const events = parseSSEChunk(`data: ${e.data}`)
          for (const event of events) {
            if (event.type === 'stage') {
              setStages((prev) => [...prev, event])
            } else if (event.type === 'heartbeat') {
              setElapsed(event.elapsed_s)
            }
          }
        }

        es.onerror = () => {
          es.close()
          reject(new Error('Stream disconnected'))
        }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main className="min-h-[100dvh] bg-[color:var(--void)] text-[color:var(--starlight)] flex flex-col items-center justify-center px-6 py-16 gap-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-[family-name:var(--font-instrument-serif)] italic">
          Plan a trip
        </h1>
        <p className="text-sm text-[color:var(--starlight)]/50 font-[family-name:var(--font-geist)]">
          Paste Instagram Reel URLs from places you want to visit.
        </p>
      </div>

      <ReelInputPanel onSubmit={handleSubmit} isLoading={isLoading} />
      <GenerationTimeline stages={stages} elapsed={elapsed} error={error} />
    </main>
  )
}
