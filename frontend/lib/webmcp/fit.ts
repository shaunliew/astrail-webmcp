/**
 * Output budget for WebMCP tool results.
 *
 * Chrome's tool-security guidance caps a single tool's output at ~1.5K characters. The cap
 * applies to what the browser actually hands the agent, NOT to our raw string: `use-webmcp-tool`
 * normalizes a returned string into `{content:[{type:"text",text}]}`, which adds ~40 characters
 * of envelope, and JSON escaping turns every newline into two characters. Measuring
 * `text.length` therefore under-counts by roughly 40% on line-dense output — which is exactly
 * the shape every itinerary formatter produces.
 *
 * So: measure the serialized envelope, and aim below the cap rather than at it.
 */

/** Hard cap from Chrome's guidance. Going over risks silent truncation by the agent runtime. */
export const OUTPUT_LIMIT = 1500

/** What we actually target, leaving room for a continuation hint. */
export const OUTPUT_TARGET = 1400

/** Length of the payload as the agent receives it, envelope and JSON escaping included. */
export function envelopeLength(text: string): number {
  return JSON.stringify({ content: [{ type: 'text', text }] }).length
}

export function fitsBudget(text: string, limit: number = OUTPUT_LIMIT): boolean {
  return envelopeLength(text) <= limit
}

export type FitBlock = {
  /** Stable identifier used to tell the agent what was omitted (e.g. a day number). */
  key: string
  lines: string[]
}

export type FitBlocksInput = {
  header: string
  blocks: FitBlock[]
  /** Trailing lines (hotel, gaps). Dropped before blocks are, since blocks carry more signal. */
  footer?: string[]
  /**
   * Rendered when blocks are omitted. Receives the dropped keys so the message can tell the
   * agent how to fetch the rest — a truncated list with no recovery path is a dead end.
   */
  continuation: (droppedKeys: string[]) => string
}

/**
 * Assemble output that fits the budget, degrading at BLOCK boundaries.
 *
 * Never truncates mid-block: half a day's stops reads to an agent as a complete day with
 * missing places, and it will confidently tell the user their afternoon is empty. Dropping a
 * whole day plus an explicit "call get_itinerary(day:N)" is recoverable; a silent half-day is not.
 */
export function fitBlocks(input: FitBlocksInput): string {
  const { header, blocks, footer = [], continuation } = input

  const assemble = (kept: FitBlock[], includeFooter: boolean, dropped: string[]): string => {
    const parts = [header, ...kept.flatMap((b) => b.lines)]
    if (includeFooter) parts.push(...footer)
    if (dropped.length > 0) parts.push(continuation(dropped))
    return parts.join('\n')
  }

  const full = assemble(blocks, true, [])
  if (fitsBudget(full, OUTPUT_TARGET)) return full

  // Step 1: drop the footer before dropping itinerary content.
  const noFooter = assemble(blocks, false, [])
  if (fitsBudget(noFooter, OUTPUT_TARGET)) return noFooter

  // Step 2: drop whole blocks from the end until it fits, naming what went.
  for (let keep = blocks.length - 1; keep > 0; keep--) {
    const kept = blocks.slice(0, keep)
    const dropped = blocks.slice(keep).map((b) => b.key)
    const candidate = assemble(kept, false, dropped)
    if (fitsBudget(candidate, OUTPUT_TARGET)) return candidate
  }

  // Floor: the header plus a recovery instruction. Always emit something actionable.
  return assemble([], false, blocks.map((b) => b.key))
}
