'use client'

import { useEffect, useRef, useState } from 'react'
// Profile (origin/style/interests) comes from the RLS-guarded traveler_profiles row and the
// remembered facts come from the backend's mem0 store — the same live reads the plan sheet
// uses, never the mock. `clearMemory` stays on mock-api pending the erasure-backend decision.
import { getProfile, getMemoryPreferences } from '@/lib/trip/supabase-api'
import { clearMemory } from '@/lib/trip/mock-api'
import type { MemoryFact, MemoryStatus, TravelerProfile } from '@/lib/trip/backend-types'
import DeleteAccountCard from '@/components/settings/DeleteAccountCard'

// Self-serve account deletion is HIDDEN until go-live: Task 6 flips this frontend flag together
// with the backend `_DELETION_EXECUTION_READY` gate. Read at render (not a module const) so it
// stays default-off in the current build while remaining togglable. Gating the child's mount here
// keeps the delete control — and its auth/session work — entirely out of the current build.
function deletionUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DELETION_ENABLED === 'true'
}

type ProfileData = { profile: TravelerProfile; status: MemoryStatus; facts: MemoryFact[] }

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-faint)]">{label}</dt>
      <dd className="text-[14px] text-[color:var(--text)]">{value}</dd>
    </div>
  )
}

// Static provenance tag for a remembered mem0 memory. Matches EvidenceChip's "Memory"
// label (KIND_LABEL.memory_preference) but drops the confidence % — mem0 carries no score.
function MemoryTag() {
  return (
    <span className="type-evidence inline-flex items-center gap-1.5 rounded-[var(--radius-chip)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] tracking-wide text-[var(--muted)]">
      <span className="font-semibold uppercase text-[var(--brass-bright)]">Memory</span>
    </span>
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
    // Profile and remembered facts are two different live sources (Supabase row vs mem0
    // backend); fetch both, then render together once the shell has real data.
    Promise.all([getProfile(), getMemoryPreferences()])
      .then(([p, mem]) => {
        if (activeRef.current) setData({ profile: p.profile, status: mem.status, facts: mem.facts })
      })
      .catch(() => {
        /* A rejected profile read leaves the loading state; the page is auth-gated so a
           signed-in user always resolves. mem0 failures degrade to status inside the read. */
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

  const { profile, status, facts } = data

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
        ) : status !== 'ok' ? (
          /* Distinguish "memory is down" from "nothing saved yet" (backend api/schemas.py):
             an empty list under a non-ok status is a failure, not an honest empty state. */
          <p className="text-[14px] text-[color:var(--text-muted)]">
            {status === 'disabled'
              ? 'Preference memory is turned off for your account.'
              : 'Couldn’t load your saved preferences right now. Try again in a moment.'}
          </p>
        ) : facts.length === 0 ? (
          <p className="text-[14px] text-[color:var(--text-muted)]">Astrail hasn’t remembered anything yet. Plan a trip and your preferences start building here.</p>
        ) : (
          /* Every remembered item is a mem0 memory, so each carries the same "Memory"
             provenance (DESIGN.md §7 disclosure). No confidence % — mem0 returns prose with
             no score, and showing an invented number would fabricate data (guardrail #1). */
          <ul className="flex flex-col gap-2.5">
            {facts.map((fact) => (
              <li key={fact.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-[color:var(--text)]">
                <span aria-hidden className="text-[color:var(--brass-deep)]">•</span> {fact.memory}
                <MemoryTag />
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

      {/* Self-serve deletion — hidden until go-live (Task 6 flips NEXT_PUBLIC_DELETION_ENABLED).
          Gated at the mount site so the control never renders in the current build. */}
      {deletionUiEnabled() ? <DeleteAccountCard /> : null}
    </div>
  )
}
