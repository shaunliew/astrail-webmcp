'use client'

import { useEffect, useState } from 'react'
import { getMemoryPreferences } from '@/lib/trip/supabase-api'
import { summarizeMemoryFacts } from '@/lib/trip/memory-summary'

/**
 * What Astrail already knows about how you travel, said on the screen you start from.
 *
 * The agent plans using preferences the user never restated in this session — that is the point of
 * remembering them — and until now the only place to see what those were was Settings. So the
 * person watching Astrail work, and anyone watching over their shoulder, had no way to know what
 * context it was acting on before it acted. This is the disclosure, one line, above the library.
 *
 * The SILENCE is the load-bearing half. Nothing renders unless memory is readable AND holds
 * something: a fresh account has nothing to disclose, so a strip there would be noise on the one
 * screen that has to stay clean, and "memory unavailable" is a status a user cannot act on
 * anyway. The disabled and unavailable states belong to Settings, which states them properly and
 * offers the controls that go with them (`components/settings/SettingsView.tsx`).
 *
 * The text is mem0 prose, which is the user's own wording round-tripped through a model and can
 * reach the store through the agent's `preferences` argument. It is rendered as text and clipped,
 * never as markup — the same treatment tool output gets on the activity rail (guardrail #11).
 */
export default function RememberedPreferences() {
  const [remembered, setRemembered] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getMemoryPreferences()
      .then((res) => {
        if (!active) return
        // `status` and `facts` answer different questions and the backend keeps them apart for
        // exactly this reason: an empty list under a non-ok status is a failed read, not an
        // honest empty. Array.isArray, not truthiness — a malformed payload is unknown.
        if (res.status !== 'ok' || !Array.isArray(res.facts)) return
        setRemembered(summarizeMemoryFacts(res.facts))
      })
      .catch(() => {
        /* `getMemoryPreferences` maps its own failures to `unavailable`, but it builds the
           Supabase client before its try block, so this can still reject. Saying nothing is the
           whole behaviour on every other unreadable state; a throw would be the home page
           falling over because it could not read a line it was only going to decorate with. */
      })
    return () => { active = false }
  }, [])

  if (!remembered) return null

  return (
    <p className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[color:var(--text-muted)]">
      {/* The same provenance word Settings and the evidence chips use, so a reader can tell this
          line is remembered rather than something they typed for this session. */}
      <span className="type-evidence inline-flex items-center rounded-[var(--radius-chip)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--brass-bright)]">
        Memory
      </span>
      <span className="line-clamp-2">Astrail remembers: {remembered}</span>
    </p>
  )
}
