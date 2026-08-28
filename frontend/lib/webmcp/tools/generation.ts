import type { GenerateTripRequest, GenerationStage } from '@/lib/trip/backend-types'
import { STAGE_LABEL } from '@/components/create/GenerationProgress'
import type { ToolSpec } from '../types'
import type { GenerationStore } from '../generation'
import { normalizeReelUrl } from '@/lib/trip/parse-inspiration'

/**
 * Starting a trip, and narrating one that is already running.
 *
 * This is the piece OpenAI's own WanderNote showcase does not have: it starts from a document the
 * user already wrote, so nothing in it takes 60-180 seconds. Here the agent has to kick off a real
 * multi-agent pipeline and then say something true about it while the user waits.
 */

export type GenerationDeps = {
  store: GenerationStore
  /** Starts the backend job and returns its trip id. */
  create: (req: GenerateTripRequest) => Promise<string>
  /** Opens the SSE stream for a trip. Kept out of `execute` so it outlives the tool call. */
  openStream: (tripId: string) => void
  /**
   * Renders an in-page approval card and resolves with the user's answer.
   * Not optional: this call spends the user's ONE lifetime free trip plus real Apify/OpenAI
   * credit. An agent must never be able to do that on its own initiative.
   */
  confirm: (summary: string) => Promise<boolean>
  /**
   * Reads the saved-reel library so the approval card can say how much of this plan Astrail has
   * already done. Only the two fields it needs — a wider type would invite the card to start
   * echoing reel internals at a moment the user is being asked to trust it.
   *
   * Optional, and a failure is SILENT by design: an unreadable library must produce no line at
   * all, never "none of these have been read". That sentence from a failed read overstates the
   * cost of approving, which is the one direction this card must never be wrong in.
   */
  readLibrary?: () => Promise<{ url: string; hasCurrentCache: boolean }[]>
}

const MAX_REELS = 5
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** Long enough to be useful, short enough that a prompt-injected caption cannot hide in it. */
const MAX_PREFERENCES = 280

/**
 * How many of these reels Astrail has already read, or `null` when we could not find out.
 *
 * `null` and `0` are deliberately different values and must stay that way: 0 is a fact about the
 * library, null is the absence of one. Collapsing them would put "none of these have been read"
 * on the card whenever the read failed — a claim that costs the user more than the truth.
 */
async function countAlreadyRead(
  read: GenerationDeps['readLibrary'], urls: string[],
): Promise<number | null> {
  if (!read) return null
  try {
    const library = await read()
    // `urls` are already normalized by the caller and the library stores normalized_url, so this
    // compares like with like — an agent's share link with a query string still matches.
    const cached = new Set(library.filter((r) => r.hasCurrentCache).map((r) => r.url))
    return urls.filter((u) => cached.has(u)).length
  } catch {
    return null
  }
}

/**
 * Says what reuse means in the user's terms — reels read, not cache hits.
 *
 * Deliberately claims no time saved. Reuse skips scrape and extract, but enrichment, narration
 * and routing still run, and nobody has measured the difference. A number invented here would be
 * on screen at the exact moment the user is deciding whether to trust the thing.
 */
function describeReuse(alreadyRead: number, total: number): string {
  if (alreadyRead === 0) {
    return total === 1
      ? 'Astrail has not read this reel yet.'
      : `None of these ${total} reels have been read yet.`
  }
  if (alreadyRead === total) {
    return total === 1
      ? 'Astrail has already read this reel and will reuse that work.'
      : `All ${total} reels have already been read \u2014 Astrail will reuse that work.`
  }
  const verb = alreadyRead === 1 ? 'has' : 'have'
  return `${alreadyRead} of ${total} reels ${verb} already been read; the rest will be read now.`
}

export function planTripFromReelsTool(deps: GenerationDeps): ToolSpec {
  return {
    name: 'plan_trip_from_reels',
    description:
      'Starts building a new trip from 1-5 saved Instagram Reels. The user must approve it on the page first, because it spends their free trip allowance. Returns in about a second with a trip_id — the trip is NOT ready yet. Generation takes 60-180 seconds; then call get_trip_progress about every 20 seconds until status is complete or failed, and narrate each stage to the user. Never call this twice for the same request.',
    inputSchema: {
      type: 'object',
      properties: {
        reel_urls: { type: 'array', description: 'Instagram Reel URLs, 1 to 5.', items: { type: 'string' } },
        start_date: { type: 'string', description: 'Trip start, YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'Trip end, YYYY-MM-DD.' },
        destination_hint: { type: 'string', description: 'Optional city or region if the user named one.' },
        budget_level: { type: 'string', description: 'budget, mid_range, premium or luxury.', enum: ['budget', 'mid_range', 'premium', 'luxury'] },
        origin_city: { type: 'string', description: 'Where the user travels from, if known.' },
        preferences: { type: 'string', description: 'Free-text preferences, max 280 chars.' },
      },
      required: ['reel_urls', 'start_date', 'end_date'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: async (args) => {
      const rawUrls = Array.isArray(args.reel_urls) ? args.reel_urls : []
      const urls = rawUrls.map((u) => (typeof u === 'string' ? normalizeReelUrl(u) : null)).filter((u): u is string => !!u)
      if (urls.length === 0) return 'No valid Instagram Reel URLs. Call list_saved_reels or ask the user for links.'
      if (urls.length > MAX_REELS) return `Too many reels — ${MAX_REELS} is the limit, got ${urls.length}.`

      const start = String(args.start_date ?? '')
      const end = String(args.end_date ?? '')
      if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) return 'start_date and end_date are required, as YYYY-MM-DD.'
      if (end < start) return 'end_date is before start_date.'

      const preferences = typeof args.preferences === 'string' ? args.preferences.slice(0, MAX_PREFERENCES) : null

      // What approving actually involves, worked out before the card is shown. Awaited rather
      // than filled in afterwards: a card that appears saying one thing and then revises itself
      // is worse than one that appears a beat later saying the right thing once.
      const alreadyRead = await countAlreadyRead(deps.readLibrary, urls)

      // The summary is shown to the user VERBATIM before anything is spent. Reel captions are
      // untrusted, so a prompt-injected preference cannot silently steer a run they never read.
      const summary = [
        `Plan a trip from ${urls.length} reel${urls.length === 1 ? '' : 's'}`,
        `Dates: ${start} to ${end}`,
        args.destination_hint ? `Destination: ${args.destination_hint}` : null,
        preferences ? `Preferences: "${preferences}"` : null,
        alreadyRead === null ? null : describeReuse(alreadyRead, urls.length),
        'This uses your trip allowance.',
      ].filter(Boolean).join('\n')

      const approved = await deps.confirm(summary)
      if (!approved) return 'The user declined. Nothing was started and nothing was spent.'

      const tripId = await deps.create({
        reel_urls: urls,
        requested_places: [],
        destination_hint: typeof args.destination_hint === 'string' ? args.destination_hint : null,
        start_date: start,
        end_date: end,
        budget_level: (args.budget_level as GenerateTripRequest['budget_level']) ?? null,
        origin_city: typeof args.origin_city === 'string' ? args.origin_city : null,
        preferences,
      } as GenerateTripRequest)

      deps.openStream(tripId)

      // `next_tool` + `poll_after_seconds` as STRUCTURED fields: agents follow those far more
      // reliably than the same instruction buried in prose.
      return JSON.stringify({
        trip_id: tripId,
        status: 'generating',
        eta_seconds: 90,
        poll_after_seconds: 20,
        next_tool: 'get_trip_progress',
        note: 'Tell the user it has started and roughly how long it takes, then poll.',
      })
    },
  }
}

export function getTripProgressTool(store: GenerationStore, minGapMs = 15_000): ToolSpec {
  return {
    name: 'get_trip_progress',
    description:
      'Progress of a trip that is still being built: seconds elapsed, the stage now running in plain language, how many stages are done, and the latest decision Astrail made. Call it about every 20 seconds and narrate each answer. If you call it again too soon it simply waits until the stage advances rather than repeating itself, so a tight loop is safe but pointless. When status is complete, stop polling and call get_itinerary.',
    inputSchema: {
      type: 'object',
      properties: { trip_id: { type: 'string', description: 'Omit to use the run started in this browser.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async () => {
      let snap = store.snapshot()
      if (!snap) return 'No trip is being generated right now. Call plan_trip_from_reels to start one.'

      // The self-throttle: rather than handing back an identical string, take a moment.
      if (snap.status === 'generating') {
        await store.waitForAdvance(snap.version, minGapMs)
        snap = store.snapshot() ?? snap
      }

      if (snap.status === 'complete') {
        return `complete · ${snap.elapsedS}s · the trip is ready and the map has moved to it\nnext_tool: get_itinerary (trip_id ${snap.tripId.slice(0, 8)})`
      }
      if (snap.status === 'failed') {
        return `failed · ${snap.elapsedS}s · stopped at "${label(snap.stage)}"${snap.lastMessage ? ` — ${snap.lastMessage}` : ''}\nTell the user, and offer to try again.`
      }
      if (snap.status === 'unknown') {
        return `unknown · ${snap.elapsedS}s · lost contact with the progress stream. The trip may still be building — ask the user to check the page.`
      }

      const parts = [
        `generating · ${snap.elapsedS}s`,
        `stage ${snap.stagesSeen}/${snap.totalStages} "${label(snap.stage)}"`,
      ]
      if (snap.lastMessage) parts.push(`last: ${snap.lastMessage}`)
      return `${parts.join(' · ')}\npoll again in ~20s`
    },
  }
}

/** Raw stage ids never reach a user — the agent narrates the same words on their screen. */
function label(stage: GenerationStage | null): string {
  if (!stage) return 'starting up'
  return STAGE_LABEL[stage] ?? stage.replaceAll('_', ' ')
}
