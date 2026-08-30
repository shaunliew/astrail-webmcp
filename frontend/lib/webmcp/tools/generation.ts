import type { GenerateTripRequest, GenerationStage } from '@/lib/trip/backend-types'
import { ERROR_CODE_RATE_LIMITED, ERROR_CODE_TRIAL_EXHAUSTED } from '@/lib/trip/backend-types'
import { ApiError } from '@/lib/trip/api'
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

/**
 * What the page can tell us about this account's remaining allowance, read at CALL time.
 *
 * `unknown` is an ANSWER, not a missing one, and it must behave exactly like `ok`: an advisory
 * read that has not landed is evidence of nothing, and a refusal we cannot substantiate costs
 * the user a trip they were entitled to. The backend RPC stays the authority in every case —
 * this exists only so we never take consent we cannot honour.
 *
 * There is deliberately no `daily_exhausted` member. The beta daily quota lives in
 * `public.user_daily_usage`, which the browser never reads (the reserving RPC is service-role
 * only), so a client-side daily refusal would be a guess. That limit gets named on the way back
 * instead, out of the backend's own rejection.
 */
export type TripAllowance = 'ok' | 'trial_exhausted' | 'unknown'

export type GenerationDeps = {
  store: GenerationStore
  /** Starts the backend job and returns its trip id. */
  create: (req: GenerateTripRequest) => Promise<string>
  /**
   * Attaches the run to the shell: opens the SSE stream, and moves the app to the page that
   * renders the wait screen. Kept out of `execute` so the STREAM outlives the tool call.
   *
   * May resolve asynchronously, and is awaited: the wait screen is the visible half of this tool,
   * so a call that returned before the page moved would tell the user a trip was building while
   * the settings page they were reading sat unchanged. It never awaits the stream itself — the
   * navigation is tens of milliseconds and bounded, the pipeline is 60-180 seconds.
   */
  openStream: (tripId: string) => void | Promise<void>
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
  /**
   * Puts one already-validated reel URL in the user's library — the same capture the app's save
   * button performs, and ONLY that half of it: it never queues extraction.
   *
   * Reading the library without ever writing to it was the reported defect. A trip planned from
   * pasted links left the collection empty and the cards thumbnail-less, because the pipeline's
   * work lands in `reel_cache` and the library reaches that table only through a `saved_reels`
   * row — which nothing on this path created. The capture RPC links the two by normalized_url
   * (`capture_saved_reel`, 20260718120000_saved_reels_foundation.sql), so a reel Astrail has
   * already read arrives with its caption and cover attached.
   *
   * Extraction is left out of THIS CALL on purpose, and that is the whole design. The organize
   * job and the generation pipeline both scrape through Apify on a cache miss (backend/
   * organizer.py `_process_item`, backend/pipeline/runner.py) and share one write-through cache
   * keyed on normalized_url + EXTRACTOR_VERSION. Queuing extraction here would race the run this
   * tool is about to start and pay Apify twice for the same reel, every time. Left out, the
   * pipeline's own scrape normally fills that cache first and organizing these reels afterwards
   * reuses it — no scrape, and no daily analysis slot (the quota is reserved only on a cache
   * MISS).
   *
   * NORMALLY, not always, and the difference is the user's money. The runner's cache write is
   * best-effort and can fail after the paid scrape succeeded (runner.py); a run can complete with
   * an individual Reel having failed, so that Reel was never cached at all; and the organizer
   * treats a cache READ failure exactly like a miss, reserving a slot and extracting again
   * (organizer.py). Sequencing is the cheapest ordering available, not a free one — say so
   * wherever this is described to a user or an agent, because an agent told something is free
   * will call it freely.
   *
   * "Afterwards" is the CALLER's job, not the agent's: GlobalTools organizes exactly these reels
   * on the run's successful terminal frame. The agent is told so, and told not to do it itself.
   *
   * Optional, and a failure is REPORTED rather than raised: the run is already under way by the
   * time this is attempted, and a library write must never cost the user the trip they approved
   * (guardrail #3).
   */
  saveToLibrary?: (url: string) => Promise<unknown>
  /**
   * Whether this account can still spend a generation, checked BEFORE the approval card.
   *
   * The manual flow gates on the same fact and renders TrialExhaustedCard before anything is
   * spent; the agent path had no entitlement dependency at all, so an exhausted account got the
   * card, approved, and was rejected afterwards.
   *
   * Optional, and a failure is fail-OPEN by design (see TripAllowance): absent, rejected, or
   * `unknown` all proceed.
   */
  readAllowance?: () => Promise<TripAllowance>
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

/**
 * What the card says about the library write, before the user agrees to it.
 *
 * Two facts, because leaving either out is a way of being wrong. That the reels are saved —
 * approving "plan a trip" must not quietly also mean "and file these in my collection". And WHEN
 * their places appear: the card view only shows places for a Reel whose `analysis_status` is
 * `organized`, which these reach only once this run has finished, so a card promising them now
 * would send the user to the same emptiness this change exists to fix — just sooner.
 *
 * It no longer says "when you organize them", because that is no longer a thing the user has to
 * do: the caller organizes them itself once the run lands (GlobalTools). Leaving the old wording
 * up would ask the user to go and repeat work that is already scheduled.
 */
function describeLibrarySave(total: number): string {
  return total === 1
    ? 'Saves this reel to your library — its places fill in once the trip is built.'
    : 'Saves these reels to your library — their places fill in once the trip is built.'
}

/**
 * Save every reel, and count what landed.
 *
 * `allSettled`, so one refused save neither hides the others nor escapes: the run this sits
 * beside is already going, and there is nothing left to abort. The COUNT is what the caller
 * reports — an agent told "saved" for a batch that half-failed sends the user to a library that
 * does not match what they were told.
 */
async function saveReelsToLibrary(
  save: NonNullable<GenerationDeps['saveToLibrary']>, urls: string[],
): Promise<number> {
  const settled = await Promise.allSettled(urls.map((u) => save(u)))
  return settled.filter((r) => r.status === 'fulfilled').length
}

/**
 * What the agent is told about the write, and — the expensive half — that it must NOT organize.
 *
 * This clause is load-bearing, not politeness. `save_reels` starts an organize job, and an
 * organize that overlaps this run misses the shared cache on both sides and buys the same Apify
 * scrape twice. It used to tell the agent to run one itself after the trip landed, which was the
 * right ordering but the wrong owner: an agent that forgot, or whose session ended with the run,
 * left the reels reading "Not analyzed" forever — the reported defect.
 *
 * So the caller now owns the ordering (GlobalTools organizes on the run's successful terminal
 * frame) and the agent is told to stay out of it. An agent that organizes anyway races that job
 * and is refused by the RPC's per-reel fence (AS409 -> HTTP 409), which is a confusing error to
 * hand a user about work that is already happening.
 */
function describeLibraryOutcome(saved: number, total: number): string {
  const noun = total === 1 ? 'reel' : 'reels'
  const ordering = `The places are not filled in yet — the ${noun} will be organized ` +
    'automatically once the trip finishes, and it normally reuses what this run read rather than ' +
    'reading them again. Not a guarantee: a Reel this run failed on, or a cached read that does ' +
    'not come back, is read again and costs an analysis slot. Do not call save_reels on these ' +
    'links to organize them yourself: it is already handled, and doing it while the trip is ' +
    'still building reads them again for certain.'
  if (saved === 0) {
    return total === 1
      ? 'The reel could not be added to the library. The trip is unaffected — tell the user the ' +
        'link was not saved and they can add it themselves.'
      : 'None of the reels could be added to the library. The trip is unaffected — tell the user ' +
        'the links were not saved and they can add them themselves.'
  }
  if (saved < total) {
    return `Added ${saved} of ${total} reels to the library; the rest were refused, so tell the ` +
      `user which links to add themselves. ${ordering}`
  }
  return total === 1
    ? `The reel is now in the user's library. ${ordering}`
    : `All ${total} reels are now in the user's library. ${ordering}`
}

/**
 * Where a beta seat is ACTUALLY asked for — the one clause in either trial refusal the user can
 * act on, so it is the one that has to be true wherever they happen to be standing.
 *
 * The request is a single button inside TrialExhaustedCard, and that card renders in exactly two
 * places: SavedReelsFlow's plan sheet (in place of the generate button), and CreateTripFlow,
 * which only exists under the mock-auth demo shell. The agent-first trays screen renders
 * neither — and that is the flow these tools were built for. This used to say "point them at the
 * 'Request a seat' card on this page", which therefore named a card that was not on the page:
 * the user hunts for it, finds nothing, and the agent looks broken at the exact moment it is
 * delivering bad news.
 *
 * So name the button, say plainly that it is not on every screen, and say that no tool can press
 * it. Shared by both refusals because an agent told only that a seat is the way out invents the
 * route, and the nearest invention is the card that is not there.
 */
const SEAT_PATH =
  'No tool can request a seat, and the "Request a seat" button is not on every screen — it sits ' +
  "on Astrail's plan screen, where the generate button would be. Tell them that, and to contact " +
  'the Astrail team if they cannot reach it.'

/**
 * Returned INSTEAD of showing the approval card. Every clause earns its place: that nothing
 * happened, that the user was never asked, WHICH limit this is, and that this particular one
 * does not come back — a trial is spent once, and only a seat lifts it. An agent told merely
 * "rejected" guesses, and half its guesses are "try again tomorrow", which is false here.
 */
const TRIAL_SPENT_BEFORE_ASKING =
  'Not started, and the user was not asked to approve — nothing was spent. Their free trial is ' +
  'one trip and it is already planned. A trial does not reset; only a beta seat lifts it. ' +
  SEAT_PATH

/** The same limit, but reached the expensive way: consent already taken, then refused. */
const TRIAL_SPENT_AFTER_ASKING =
  'The user approved, but the backend refused: their free trial is one trip and it is already ' +
  'planned. No trip was created and nothing was spent. A trial does not reset; only a beta seat ' +
  'lifts it, and retrying will not change that. ' + SEAT_PATH

/**
 * A 429 is quoted, never paraphrased. `rate_limited` is the slug for BOTH the beta daily quota
 * and the per-minute burst limiter (api/errors.py maps every 429 to it), and those lift on
 * completely different clocks — one tomorrow, one in under a minute. Only the backend's own
 * sentence knows which, so it is what the agent relays.
 */
function rateLimitedReply(message: string): string {
  return `The user approved, but the backend refused: "${message}" No trip was created and ` +
    'nothing was spent. Relay that sentence to the user — it names the limit and when it lifts. ' +
    'Do not call this again until they ask.'
}

/**
 * Consult the allowance without letting it block. A rejected reader is caught here too: the
 * contract says it resolves to a verdict, but the ONE outcome this gate must never produce is a
 * refusal it cannot substantiate, so the failure is handled rather than trusted away.
 */
async function resolveAllowance(read: GenerationDeps['readAllowance']): Promise<TripAllowance> {
  if (!read) return 'unknown'
  try {
    return await read()
  } catch {
    return 'unknown'
  }
}

/**
 * Turn a rejection from `create` into something the agent can say, or `null` to let it throw.
 *
 * NARROW on purpose. A broad catch here would turn a 503, a lost run lock and a dropped
 * connection into calm sentences the activity rail marks "done" — only the two entitlement
 * refusals are things that legitimately did not happen.
 */
function refusalReply(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null
  if (err.code === ERROR_CODE_TRIAL_EXHAUSTED) return TRIAL_SPENT_AFTER_ASKING
  if (err.code === ERROR_CODE_RATE_LIMITED) return rateLimitedReply(err.message)
  return null
}

export function planTripFromReelsTool(deps: GenerationDeps): ToolSpec {
  return {
    name: 'plan_trip_from_reels',
    description:
      'Starts building a new trip from 1-5 Instagram Reel links — saving them first is optional, raw pasted links work and are added to the library. The user must approve it on the page first, because it spends their free trip allowance. Returns in about a second with a trip_id — the trip is NOT ready yet. Generation takes 60-180s; then call get_trip_progress about every 20 seconds until status is complete or failed, and narrate each stage to the user. Never call this twice for the same request.',
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
      // The library is keyed on (user_id, normalized_url), so a link the agent mentioned twice is
      // ONE row. Deduped only for the save — `urls` still goes to the pipeline as given, which is
      // pre-existing behaviour this change has no business altering.
      const distinctUrls = [...new Set(urls)]
      if (urls.length === 0) return 'No valid Instagram Reel URLs. Call list_saved_reels or ask the user for links.'
      if (urls.length > MAX_REELS) return `Too many reels — ${MAX_REELS} is the limit, got ${urls.length}.`

      const start = String(args.start_date ?? '')
      const end = String(args.end_date ?? '')
      if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) return 'start_date and end_date are required, as YYYY-MM-DD.'
      if (end < start) return 'end_date is before start_date.'

      const preferences = typeof args.preferences === 'string' ? args.preferences.slice(0, MAX_PREFERENCES) : null

      // Before the card, not after it. The manual flow renders TrialExhaustedCard instead of a
      // Generate button, so nothing is spent and nothing is consented to; this path used to show
      // the card, take the approval, and only then be rejected by the backend. Courtesy gate
      // only — the reserving RPC still enforces it, and an `unknown` verdict proceeds.
      if (await resolveAllowance(deps.readAllowance) === 'trial_exhausted') return TRIAL_SPENT_BEFORE_ASKING

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
        deps.saveToLibrary ? describeLibrarySave(urls.length) : null,
        'This uses your trip allowance.',
      ].filter(Boolean).join('\n')

      const approved = await deps.confirm(summary)
      if (!approved) return 'The user declined. Nothing was started and nothing was spent.'

      // The gate above is advisory, so a stale client state or a generation started in another
      // tab still lands here — with the user's consent already taken. What came back then was an
      // isError text response carrying the backend's own sentence, which never says the run did
      // not start. Only the two entitlement refusals are translated; everything else throws.
      let tripId: string
      try {
        tripId = await deps.create({
          reel_urls: urls,
          requested_places: [],
          destination_hint: typeof args.destination_hint === 'string' ? args.destination_hint : null,
          start_date: start,
          end_date: end,
          budget_level: (args.budget_level as GenerateTripRequest['budget_level']) ?? null,
          origin_city: typeof args.origin_city === 'string' ? args.origin_city : null,
          preferences,
        } as GenerateTripRequest)
      } catch (err) {
        const refused = refusalReply(err)
        if (refused) return refused
        throw err
      }

      // Awaited: this both opens the stream and takes the user to the screen that renders it.
      // See GenerationDeps.openStream — the tool must not report a run the page has not reached.
      await deps.openStream(tripId)

      /* The library write, and it is LAST for two reasons.
         After `create`, so every refusal above keeps saying "nothing was spent" about a library
         that was genuinely not touched — a save is not a spend, but a user told nothing happened
         should not find three new rows in their collection.
         After `openStream`, so a slow capture delays nothing the user is waiting on: the wait
         screen is already up, and these are plain DB inserts behind it. */
      const savedCount = deps.saveToLibrary
        ? await saveReelsToLibrary(deps.saveToLibrary, distinctUrls)
        : null

      // `next_tool` + `poll_after_seconds` as STRUCTURED fields: agents follow those far more
      // reliably than the same instruction buried in prose.
      return JSON.stringify({
        trip_id: tripId,
        status: 'generating',
        eta_seconds: 90,
        poll_after_seconds: 20,
        next_tool: 'get_trip_progress',
        ...(savedCount === null ? {} : {
          saved_to_library: savedCount,
          library: describeLibraryOutcome(savedCount, distinctUrls.length),
        }),
        note: 'Tell the user it has started and roughly how long it takes, then poll.',
      })
    },
  }
}

/**
 * How much of a trip id this tool prints, and therefore the shortest prefix it will accept back.
 */
const TRIP_ID_PREFIX = 8

/**
 * Is `asked` the run this browser is following?
 *
 * The store is browser-local and holds ONE run, so a `trip_id` can only ever be confirmed or
 * contradicted here — never looked up. It used to be neither: the schema advertised the
 * parameter and `execute` took no argument at all, so an agent with two trips in play could ask
 * about A and be told, fluently and in natural language, about B. Nothing errored, which is what
 * made it the worst kind of wrong in the one tool whose job is narrating truthfully.
 *
 * Prefixes are accepted because this tool PRINTS one: the completion line hands back
 * `trip_id <first 8 chars>`, so both forms come back at us and refusing our own output would be
 * a self-inflicted mismatch. They are accepted only from that same length up — a looser match is
 * the very bug, so anything shorter is refused rather than guessed at.
 */
function isThisRun(tripId: string, asked: string): boolean {
  const q = asked.trim().toLowerCase()
  const id = tripId.toLowerCase()
  return q === id || (q.length >= TRIP_ID_PREFIX && id.startsWith(q))
}

/**
 * Said instead of another trip's progress. Names the run this page DOES hold, because a bare
 * refusal leaves the agent guessing which of its trips this browser is following, and offers the
 * one recovery that exists — a finished trip is readable by id, a run built elsewhere is not
 * visible from here at all.
 */
function otherRunReply(tripId: string): string {
  return `Not the run this browser is following — that is trip ${tripId.slice(0, TRIP_ID_PREFIX)}, ` +
    'and only one is tracked per browser, so there is no progress here for the trip you asked ' +
    'about. If it is already built, call get_itinerary with its id.'
}

export function getTripProgressTool(store: GenerationStore, minGapMs = 15_000): ToolSpec {
  return {
    name: 'get_trip_progress',
    description:
      'Progress of a trip that is still being built: seconds elapsed, the stage now running in plain language, how many stages are done, and the latest decision Astrail made. Call it about every 20 seconds and narrate each answer. If you call it again too soon it simply waits until the stage advances rather than repeating itself, so a tight loop is safe but pointless. When status is complete, stop polling and call get_itinerary.',
    inputSchema: {
      type: 'object',
      properties: { trip_id: { type: 'string', description: 'The trip you are asking about, checked against the one run this browser follows. Omit for that run.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const asked = typeof args.trip_id === 'string' ? args.trip_id.trim() : ''
      let snap = store.snapshot()
      if (!snap) return 'No trip is being generated right now. Call plan_trip_from_reels to start one.'
      if (asked && !isThisRun(snap.tripId, asked)) return otherRunReply(snap.tripId)

      // The self-throttle: rather than handing back an identical string, take a moment.
      if (snap.status === 'generating') {
        await store.waitForAdvance(snap.version, minGapMs)
        snap = store.snapshot() ?? snap
        // Checked again, because start() replaces the snapshot wholesale: a run beginning during
        // those seconds would otherwise be reported as progress for the trip that was asked
        // about. Same silent-wrong answer, arriving through the back door.
        if (asked && !isThisRun(snap.tripId, asked)) return otherRunReply(snap.tripId)
      }

      if (snap.status === 'complete') {
        return `complete · ${snap.elapsedS}s · the trip is ready and the map has moved to it\nnext_tool: get_itinerary (trip_id ${snap.tripId.slice(0, TRIP_ID_PREFIX)})`
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
