'use client'

import { useEffect, useState } from 'react'
import { useOptionalWebMcpRegistry } from './WebMcpRegistry'

/**
 * What the agent just did, where the user can see it.
 *
 * This is the difference between an agent operating your app and an agent operating it *with*
 * you. Every tool call surfaces here — reads included, because a read the user never sees is a
 * read they could not have consented to. It is simultaneously the UX affordance and the audit log.
 *
 * Entries are written in the app's vocabulary ("MOVED  7 · Senso-ji → Day 3"), never the tool's.
 */

const FADE_AFTER_MS = 8_000

export default function AgentActivityRail() {
  const registry = useOptionalWebMcpRegistry()
  const [now, setNow] = useState(() => Date.now())

  const hasEntries = (registry?.activity.length ?? 0) > 0
  useEffect(() => {
    if (!hasEntries) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [hasEntries])

  if (!registry) return null
  const visible = registry.activity.filter(
    (e) => e.status === 'running' || now - e.at < FADE_AFTER_MS,
  )
  if (visible.length === 0) return null

  return (
    <div
      aria-live="polite"
      aria-label="Agent activity"
      className="pointer-events-none w-[min(22rem,100%)] space-y-1.5"
    >
      {visible.map((e) => (
        <div
          key={e.id}
          className="rounded-lg border border-[#C9974E]/40 bg-black/80 px-3 py-2 text-xs backdrop-blur"
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={[
                'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                e.status === 'running' ? 'animate-pulse bg-[#C9974E]' : e.status === 'failed' ? 'bg-red-400' : 'bg-[#C9974E]/60',
              ].join(' ')}
            />
            <span className="text-[10px] uppercase tracking-wider text-[#E8D5B0]">{e.label}</span>
          </div>
          {e.detail && (
            /* Tool output can carry Reel-caption text, so it renders as text and is clipped. */
            <p className="mt-0.5 line-clamp-2 pl-3.5 text-white/70">{e.detail}</p>
          )}
        </div>
      ))}
    </div>
  )
}
