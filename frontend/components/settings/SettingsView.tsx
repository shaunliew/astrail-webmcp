'use client'

import { useEffect, useRef, useState } from 'react'
import { getProfile, clearMemory } from '@/lib/trip/mock-api'
import type { TravelerProfile, UserPreferenceFact } from '@/lib/trip/backend-types'
import { memoryReceipt } from '@/lib/profile/memory'
import EvidenceChip from '@/components/trip/EvidenceChip'

type ProfileData = { profile: TravelerProfile; facts: UserPreferenceFact[] }

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-faint)]">{label}</dt>
      <dd className="text-[14px] text-[color:var(--text)]">{value}</dd>
    </div>
  )
}

const CARD = 'flex flex-col gap-4 rounded-2xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] p-5'

export default function SettingsView() {
  const [data, setData] = useState<ProfileData | null>(null)
  const [cleared, setCleared] = useState(false)
  const [clearing, setClearing] = useState(false)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    getProfile().then((d) => {
      if (activeRef.current) setData(d)
    })
    return () => {
      activeRef.current = false
    }
  }, [])

  async function handleClear() {
    setClearing(true)
    await clearMemory()
    if (!activeRef.current) return
    setCleared(true)
    setClearing(false)
  }

  if (!data) {
    return <p className="text-[14px] text-[color:var(--text-muted)]">Loading your settings…</p>
  }

  const { profile } = data
  const receipt = memoryReceipt(data.facts)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <h1
        className="font-display text-[28px] font-medium tracking-[-0.015em] text-[color:var(--text)]"
        style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 1, 'opsz' 28" }}
      >
        Settings
      </h1>

      <section className={CARD}>
        <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">Using your saved travel preferences</h2>
        <dl className="flex flex-col gap-3">
          <Row label="Origin" value={profile.origin_city ?? 'Not set'} />
          <Row label="Travel style" value={profile.travel_style_tags.join(', ') || 'None yet'} />
          <Row label="Interests" value={profile.preference_tags.join(', ') || 'None yet'} />
          <Row label="Notes" value={profile.preference_notes ?? 'None'} />
        </dl>
      </section>

      <section className={CARD}>
        <div>
          <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">What Astrail remembers</h2>
          <p className="mt-1 text-[13px] text-[color:var(--text-muted)]">
            Every remembered fact shows where it came from. Clearing it takes effect on your next trip.
          </p>
        </div>

        {cleared ? (
          <p className="text-[14px] text-[color:var(--text-muted)]">Memory cleared. Astrail will infer fresh preferences next time.</p>
        ) : (
          /* Disclosure is a feature: every learned fact renders with its provenance —
             Memory for what Astrail inferred, You for what the user stated (G7). Same
             EvidenceChip as every other claim in the product (DESIGN.md §7). */
          <ul className="flex flex-col gap-2.5">
            {receipt.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-[color:var(--text)]">
                <span aria-hidden className="text-[color:var(--brass-deep)]">•</span> {entry.line}
                <EvidenceChip evidence={entry.evidence} />
              </li>
            ))}
          </ul>
        )}

        {/* Clear-all memory is a destructive action the user takes and can't undo —
            the one place --fail belongs on a control (DESIGN.md §9 / palette). */}
        <button
          type="button"
          onClick={handleClear}
          disabled={cleared || clearing}
          className="mt-2 self-start rounded-lg border border-[color:var(--fail)] px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--fail)] transition-colors hover:bg-[color:var(--surface-2)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
        >
          {clearing ? 'Clearing…' : 'Clear memory'}
        </button>
      </section>
    </div>
  )
}
