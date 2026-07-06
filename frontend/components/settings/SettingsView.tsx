'use client'

import { useEffect, useRef, useState } from 'react'
import { getProfile, clearMemory } from '@/lib/trip/mock-api'
import type { TravelerProfile, UserPreferenceFact } from '@/lib/trip/backend-types'
import { memoryReceiptLines } from '@/lib/profile/memory'

type ProfileData = { profile: TravelerProfile; facts: UserPreferenceFact[] }

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">{label}</dt>
      <dd className="type-body text-sm text-[var(--starlight)]">{value}</dd>
    </div>
  )
}

export default function SettingsView() {
  const [data, setData] = useState<ProfileData | null>(null)
  const [cleared, setCleared] = useState(false)
  const [clearing, setClearing] = useState(false)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    getProfile().then((d) => { if (activeRef.current) setData(d) })
    return () => { activeRef.current = false }
  }, [])

  async function handleClear() {
    setClearing(true)
    await clearMemory()
    if (!activeRef.current) return
    setCleared(true)
    setClearing(false)
  }

  if (!data) {
    return (
      <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl items-center justify-center bg-[var(--void)] p-6">
        <p className="type-body text-sm text-[var(--muted)]">Loading your settings…</p>
      </main>
    )
  }

  const { profile } = data
  const lines = memoryReceiptLines(data.facts)

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-8 bg-[var(--void)] p-6">
      <h1 className="type-display text-3xl text-[var(--starlight)]">Settings</h1>

      <section className="surface flex flex-col gap-3 rounded-xl p-5">
        <h2 className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
          Using your saved travel preferences
        </h2>
        <dl className="flex flex-col gap-2">
          <Row label="Origin" value={profile.origin_city ?? 'Not set'} />
          <Row label="Travel style" value={profile.travel_style_tags.join(', ') || 'None yet'} />
          <Row label="Interests" value={profile.preference_tags.join(', ') || 'None yet'} />
          <Row label="Notes" value={profile.preference_notes ?? 'None'} />
        </dl>
      </section>

      <section className="surface flex flex-col gap-3 rounded-xl p-5">
        <h2 className="type-display text-lg text-[var(--starlight)]">Astrail learned:</h2>
        {cleared ? (
          <p className="type-body text-sm text-[var(--muted)]">
            Memory cleared. Astrail will infer fresh preferences next time.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {lines.map((line) => (
              <li key={line} className="type-body flex items-center gap-2 text-sm text-[var(--starlight)]">
                <span aria-hidden className="text-[var(--brass)]">•</span> {line}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={handleClear}
          disabled={cleared || clearing}
          className="type-label mt-2 self-start rounded-lg border border-[var(--line)] px-3 py-2 text-xs uppercase tracking-wide text-[var(--muted)] transition-colors hover:text-[var(--starlight)] disabled:opacity-40"
        >
          {clearing ? 'Clearing…' : 'Clear memory'}
        </button>
      </section>
    </main>
  )
}
