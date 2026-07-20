import type { GenerationEvent, GenerationEventType } from '@/lib/trip/backend-types'

const DOT_COLOR: Record<GenerationEventType, string> = {
  stage: 'var(--faint)',
  decision: 'var(--brass)',
  warning: 'var(--starlight)',
  error: 'var(--starlight)',
  heartbeat: 'var(--faint)',
  result: 'var(--brass)',
}

export default function AgentDecisionRail({ events }: { events: GenerationEvent[] }) {
  if (events.length === 0) {
    return <p className="type-body text-xs text-[var(--muted)]">No agent activity recorded.</p>
  }
  return (
    <ol className="flex flex-col">
      {events.map((ev) => (
        <li key={ev.id} className="relative flex gap-3 pb-3 last:pb-0">
          <span
            aria-hidden
            className="mt-1 h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: DOT_COLOR[ev.event_type] }}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">{ev.stage}</span>
              {ev.event_type === 'warning' ? (
                <span className="type-label text-[9px] uppercase tracking-wide text-[var(--warn)]">warning</span>
              ) : null}
            </div>
            <p className="type-body text-xs text-[var(--muted)]">{ev.message}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}
