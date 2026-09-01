import type { Trip } from '@/lib/trip/backend-types'

/**
 * What steered THIS trip, on the trip itself.
 *
 * Deliberately a different question from the home screen's panel, and the two must not be merged.
 * Home answers "what does Astrail know about me" — profile state, current, changes when you state
 * something new. This answers "what shaped this itinerary" — historical, frozen at generation
 * time. Showing today's profile against a trip planned last month would be a lie the moment the
 * two diverge, which is precisely when a reader would most want the answer.
 *
 * It reads `trips.preference_summary`, which the pipeline has always persisted and nothing has
 * ever rendered (`api/schemas.py`, written at `pipeline/runner.py`). The sample trail carries it
 * in its fixture, so the one path a judge can open with no account shows the memory story too.
 *
 * `preference_sources` names WHERE it came from, and the copy follows it rather than assuming:
 * a trip the user stated preferences for was not steered by memory, and saying so would claim a
 * recall that never ran.
 */
export default function TripPreferenceNote({ trip }: { trip: Trip }) {
  const summary = typeof trip.preference_summary === 'string' ? trip.preference_summary.trim() : ''
  if (!summary) return null

  const sources = Array.isArray(trip.preference_sources) ? trip.preference_sources : []
  const fromMemory = sources.includes('memory')
  // Neither source is a reason to stay silent — the note is about what shaped the trip, and a
  // stated preference shaped it just as much. Only the attribution changes.
  const label = fromMemory ? 'Planned around what Astrail remembers' : 'Planned around what you asked for'

  return (
    <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[color:var(--text-muted)]">
      {fromMemory ? (
        /* The same provenance word Settings, the home panel and the evidence chips use. Brass-deep
           rather than brass-bright: this panel is the paper palette, where the bright token is
           the near-white one meant for night surfaces. */
        <span className="type-evidence inline-flex items-center rounded-[var(--radius-chip)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--brass-deep)]">
          Memory
        </span>
      ) : null}
      <span className="type-label text-[11px] uppercase tracking-wide text-[color:var(--text-faint)]">{label}</span>
      {/* Plain text: this is the user's own wording round-tripped through a model, and it can
          reach the store through the agent's `preferences` argument (guardrail #11). */}
      <span className="text-[color:var(--text)]">{summary}</span>
    </p>
  )
}
