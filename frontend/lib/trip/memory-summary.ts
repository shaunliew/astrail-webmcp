import type { MemoryFact } from '@/lib/trip/backend-types'

/**
 * The one sentence that names what Astrail has remembered about a traveller.
 *
 * Shared by the two surfaces that state it — the home screen's line and the approval card the
 * user reads before spending their trip allowance — because those two must not drift. Being told
 * "Astrail remembers: walkable days" on one screen and something else on the next is worse than
 * being told nothing on either.
 *
 * Two caps, and they bound different things. `MAX_FACTS` bounds how many memories are named,
 * because mem0 puts no ceiling on what one account accumulates and an unbounded list turns the
 * home page into a wall and pushes the card's actual decision off the bottom. `MAX_CHARS` bounds
 * the length, because the count says nothing about the size of any one memory: mem0 prose reaches
 * the store through the agent's `preferences` argument, so a single memory can be as long as a
 * caption. Neither cap makes this text trusted — it is the user's own words round-tripped through
 * a model, and every caller renders it as plain text, never as markup.
 */
export const MEMORY_SUMMARY_MAX_FACTS = 3
export const MEMORY_SUMMARY_MAX_CHARS = 160

/** The separator, matching how the app already lists peers ("Kyoto · 3 days · 6 stops"). */
const JOINER = ' · '

/**
 * The summary, or `null` when there is nothing honest to say.
 *
 * `null` rather than an empty string so callers cannot render a bare "Astrail remembers:" with
 * nothing after it — a claim to a memory that does not exist. Every entry is re-checked for being
 * a non-blank string rather than trusted: `facts` is parsed straight out of a JSON response, so
 * `memory` is whatever came over the wire, and a non-string used to render as `undefined` in the
 * middle of the sentence.
 */
export function summarizeMemoryFacts(facts: readonly MemoryFact[]): string | null {
  const named = facts
    .map((fact) => (typeof fact?.memory === 'string' ? fact.memory.trim() : ''))
    .filter((memory) => memory.length > 0)
    .slice(0, MEMORY_SUMMARY_MAX_FACTS)

  if (named.length === 0) return null

  const line = named.join(JOINER)
  return line.length <= MEMORY_SUMMARY_MAX_CHARS
    ? line
    : `${line.slice(0, MEMORY_SUMMARY_MAX_CHARS).trimEnd()}…`
}
