import type { TripBundle } from '@/lib/trip/backend-types'
import type { ToolSpec } from '../types'
import { resolvePlaceRef } from '../resolve'
import { buildTrailNumbers } from '@/lib/trip/selectors'
import { resolveBundle, type TripReader } from './trips'

/**
 * Editing a finished itinerary — the capability Astrail did not have at ANY layer before this.
 *
 * No edit endpoint, no frontend mutation, and Supabase RLS was SELECT-only, so even an agent
 * that understood "day 2 is packed" could only describe what the user should change. This is what
 * turns the agent from a narrator into a collaborator.
 *
 * Reversibility decides the interaction: `move_place` applies without a card because the row it
 * writes can be written again, so it RECORDS the day and position the stop came from. That is a
 * record, not an undo — `trip_places.sort_order` is nullable by design (migration
 * 20260701162954: `sort_order is null or sort_order >= 0`), `to_position` starts at 1, and the
 * backend patch drops nulls (`model_dump(exclude_none=True)`), so a stop that had no recorded
 * position cannot be put back exactly. The reply says what it knows and promises nothing more.
 * `remove_place` is not reversible at all, so it asks first.
 *
 * The other half of an edit is the prose. See `editResult`.
 */

export type EditDeps = {
  trips: TripReader
  add: (tripId: string, body: { name: string; day_number: number; position?: number | null; lat?: number | null; lng?: number | null }) => Promise<unknown>
  setDates: (tripId: string, body: { start_date?: string | null; end_date?: string | null }) => Promise<unknown>
  /**
   * Rewrites the summaries so they describe the stops the trip actually has.
   *
   * One run at a time per trip PER TAB: the shell coalesces on trip id, so a caller that only
   * wants current prose joins the run already going instead of buying a second narration. Per tab
   * because the count behind it lives in memory — another tab, or a run this tab stopped waiting
   * for after a timeout, is outside what it can see. It announces itself on the activity rail —
   * the only surface on which a rewrite nobody approved becomes visible — and it still REJECTS on
   * failure, so `replan_trip` can report that.
   *
   * `afterEdit` is not optional in spirit, only in type. The backend reads the trip's stops and
   * THEN awaits the narrator for ~30 seconds (`persist_narration`), so a run that started before
   * an edit writes prose that cannot know about it. Passing `afterEdit` raises the version the
   * prose owes, which is what stops the shell joining such a run and reporting the summaries as
   * current. Every call that follows a mutation must set it; nothing else may.
   */
  replan: (
    tripId: string,
    opts?: { afterEdit?: boolean },
  ) => Promise<{ days_narrated: number; routes_refreshed: boolean }>
  /**
   * Whether a rewrite is already running for this trip.
   *
   * Optional, and its absence reads as "no idea", which degrades to asking — the behaviour
   * before any of this existed. Never the other way round: a missing answer must not be able to
   * skip an approval card.
   */
  replanInFlight?: (tripId: string) => boolean
  move: (tripId: string, tripPlaceId: string, patch: { day_number?: number; sort_order?: number }) => Promise<unknown>
  remove: (tripId: string, tripPlaceId: string) => Promise<unknown>
  /** Re-reads the trip so the page reflects the change before the tool reports success. */
  refresh: (tripId: string) => Promise<TripBundle | null>
  /**
   * Shows the approval card and answers with what the user chose.
   *
   * `'unavailable'` means no card could be shown at all — another is already waiting — and is a
   * third answer rather than a `false`, because "the registry refused to ask" and "the user said
   * no" are different facts and the tool states one of them out loud. Kept as `boolean |
   * 'unavailable'` rather than a three-word enum so that every existing caller and test that
   * answers `true`/`false` still says exactly what it always did.
   */
  confirm: (summary: string) => Promise<boolean | 'unavailable'>
}

/** Renumbering after an edit is the point of pin numbers: they must describe what is on screen now. */
function pinsLine(bundle: TripBundle | null, name: string): string {
  if (!bundle) return ''
  const pin = [...buildTrailNumbers(bundle).entries()].find(
    ([id]) => bundle.places.find((p) => p.id === id)?.place.name === name,
  )?.[1]
  return pin ? ` It is now stop ${pin}.` : ''
}

/**
 * Whether the call did the thing, or did not — as a closed set rather than a sentence.
 *
 * Every mutating tool here has three ordinary endings and only one of them is a change: the edit
 * lands, the user declines the approval card, or it never happens (a backend refusal, or an
 * argument the tool bounced). All three used to leave by the same door — a plain string, returned
 * normally — so the only thing downstream could tell was that `execute` had not thrown. The
 * activity rail read that as success and wrote `REMOVED · You · done` with "Astrail can't undo
 * this" under it, for a removal the user had just refused. A durable record asserting the
 * opposite of what happened, on the surface we advertise as the accountability layer.
 *
 * The alternative was to sniff the prose ("The user declined."). That is a claim assembled from
 * text that is partly caption-derived (guardrail #11) and it rots the first time someone reworks
 * a sentence. This is a value our own code writes before any output is assembled: the model
 * cannot pick it and a caption cannot reach it.
 */
export type EditVerdict = 'done' | 'declined' | 'failed'

/** The vocabulary itself, so a reader can validate rather than trust. */
export const EDIT_VERDICTS: readonly EditVerdict[] = ['done', 'declined', 'failed']

type EditOutcome = {
  /** What happened, in the words the agent repeats to the user. */
  result: string
  /** Whether the trip actually changed. Omitted means it did — the only path that writes. */
  verdict?: EditVerdict
  /** True when the persisted summaries now describe stops the trip no longer has. */
  summariesStale: boolean
  /** True when this call has already started the rewrite that fixes them. */
  summariesRewriting?: boolean
  /** Anything the agent must act on before its next call — renumbering, a stale forecast. */
  notes?: string[]
}

/**
 * The answer to a completed edit, as fields rather than a sentence.
 *
 * The prose goes stale because it is written FROM the stops — the narrator's input is each day's
 * ordered stop list and date (`backend/genagents/narrator.py`, `build_narrator_input`, fed by
 * `persist_narration`) — while every edit endpoint refreshes routes and leaves `trip_days.summary`
 * alone. Nothing else in the system notices.
 *
 * This file used to only TELL the agent, naming `replan_trip` in `next_tool` and leaving the call
 * to it. That was survivable after an ADD, where the summary is merely incomplete. After a REMOVE
 * it is FALSE: a user removed Tokyo Tower and was left reading "the day ... ends at Tokyo Tower"
 * about a stop that no longer exists. A product whose entire argument is that nothing on screen
 * claims more than it can support cannot ship self-contradiction as the default and correctness as
 * an opt-in the user has to know to ask for. So the edit starts the rewrite itself.
 *
 * Which changes what the agent has to be told. `summaries_stale` still says what is TRUE right
 * now — the persisted prose does not match the stops — and `summaries_rewriting` says the fix is
 * already running, so the agent describes the state instead of acting on it. `next_tool` survives
 * for the one case where the agent must still act: stale, with nothing running.
 */
function editResult(outcome: EditOutcome): string {
  const rewriting = outcome.summariesRewriting === true
  const notes = [
    ...(outcome.notes ?? []),
    ...(outcome.summariesStale
      ? [
          rewriting
            ? 'Astrail is already rewriting the day and trip summaries; until that lands they still describe the trip before this edit, so do not quote them and do not call replan_trip.'
            : 'The day and trip summaries still describe the itinerary before this edit.',
        ]
      : []),
  ]
  return JSON.stringify({
    result: outcome.result,
    // Named for the agent as much as for the rail: a model reading "The user declined." as prose
    // among a dozen other result sentences mis-reads it, in exactly the way `next_tool` exists to
    // prevent. One value, one meaning, told to both readers — the alternative, a side channel the
    // rail sees and the agent does not, would give the two of them different accounts of the same
    // call, which is the fault being fixed rather than a fix for it.
    outcome: outcome.verdict ?? 'done',
    summaries_stale: outcome.summariesStale,
    ...(rewriting ? { summaries_rewriting: true } : {}),
    // Only when the agent is the one who has to act. Naming `replan_trip` beside a rewrite that
    // is already running is an instruction to buy a second narration, and the agent follows
    // `next_tool` far more reliably than it follows the sentence telling it not to.
    ...(outcome.summariesStale && !rewriting ? { next_tool: 'replan_trip' } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  })
}

/**
 * A call that ended without changing anything.
 *
 * Every bail-out in this file goes through here, not only the two the approval card produces. A
 * `move_place` that resolved no stop, or was handed neither a day nor a position, is just as
 * incapable of having moved anything as one the user refused — and the rail was labelling those
 * `MOVED` too. The agent still reads the same sentence it always did; nothing about the wording
 * changed, only that the reply now says which of the three endings it is.
 */
function noChange(verdict: 'declined' | 'failed', result: string): string {
  return editResult({ result, verdict, summariesStale: false })
}

/**
 * Said when no card could be SHOWN, which is not the same as a card being refused.
 *
 * `requestConfirm` allows one approval at a time and turns a second request away on the spot.
 * That refusal used to arrive as `false` — the same value a real "Not now" produces — so every
 * gated tool answered "The user declined", the agent repeated it to the user as fact, and the
 * rail wrote it into a permanent record against "You". Nobody had been asked anything.
 *
 * It is `failed`, not `declined`: nothing was decided, and the call is worth retrying once the
 * card on screen has been answered, which is the opposite of what a decline means.
 */
const NO_CARD =
  'Astrail could not show the approval card — another one is already waiting to be answered. Ask again once it has been.'

/** Said on the one path where the edit is real and the screen is not. */
const STALE_VIEW = 'Astrail could not re-read the trip, so the page may still show the old version — reload it.'

/**
 * Re-read the trip, treating a failed re-read as a stale VIEW rather than a failed edit.
 *
 * The mutation is awaited inside its own try; this call sat outside every one of them, so a
 * refresh that threw escaped `execute` — and the wrapper's catch recorded the whole call as
 * `failed`. That is the inverse of the bug this file just fixed and it is no better: the stop had
 * moved, the trip was different, and the permanent record said it never happened. Worse, the
 * agent was told the same thing, which invites it to retry a mutation that already landed.
 *
 * The outcome has to follow the DATA. So the failure is downgraded, never dropped: the reply says
 * the page is behind, in `result` rather than in a note, because `result` is the line the activity
 * rail shows — the reader looking at an unchanged screen is the person who most needs to know the
 * change did happen. Both readers get one account of it, which is the rule this file already
 * follows for the outcome itself.
 */
async function refreshView(deps: EditDeps, tripId: string): Promise<{ fresh: TripBundle | null; stale: boolean }> {
  try {
    const fresh = await deps.refresh(tripId)
    // A NULL bundle is not a quieter success, and it is the likelier of the two failures. The
    // dep resolves to `getTrip(tripId)` when no page has published a refresher, and `getTrip`
    // answers `null` for an error OR an RLS miss without ever throwing
    // (lib/trip/supabase-api.ts: "another user's trip reads as absent"). So the first version of
    // this guard caught the throw, walked the null straight into the success copy, and left
    // `move_place` saying "The map has redrawn." having confirmed nothing at all.
    return { fresh, stale: fresh === null }
  } catch {
    // Deliberately not surfaced verbatim: this is a GET failing, not the edit, and its message
    // would read as the edit's own error on a call that succeeded.
    return { fresh: null, stale: true }
  }
}

/**
 * Start the rewrite this edit just made necessary, and get out of the way.
 *
 * Deliberately NOT awaited, and that is the whole shape of the fix. Narration is an LLM call —
 * roughly 30 seconds for a two-day trip in the measured run — while an edit resolves in about a
 * second. Awaiting it inside the mutation would make every `remove_place` a thirty-second tool
 * call on a tool an agent calls several times in a row, trading a visible wrong summary for an
 * agent that looks hung. Folding it into the mutation's own approval card costs the same thirty
 * seconds; the card is not what is slow.
 *
 * So the mutation resolves when the STRUCTURAL change is on screen — `refreshView` has already
 * re-read the trip, so the map, the stop list and the pin numbers are current — and the prose
 * catches up behind it. That is the honest reading of this file's own rule that a mutation
 * resolves only once the UI reflects it: what the user changed is reflected, and the one part
 * that is not is announced as in progress rather than left to be discovered. The activity rail
 * carries that announcement (`REWRITE`, pulsing, then `REWROTE`), which is also the receipt for
 * an LLM call nobody approved — it costs no trip allowance (`/trips/{id}/replan` has no quota
 * reserve and no entitlement check, only the burst limiter) but it is still real work done on the
 * user's behalf, and unseen work is work they could not consent to.
 *
 * The `catch` swallows nothing that is not already recorded: the shell's `replan` ends the rail
 * entry as FAILED before it rejects. Guardrail #3 — the edit LANDED, and a failed rewrite must
 * not turn a completed removal into a failed one, so the rejection dies here rather than
 * escaping into the tool's own outcome.
 */
function startSummaryRewrite(deps: EditDeps, tripId: string): void {
  void deps
    // `afterEdit` because the stops just changed: the shell must not satisfy this with a run that
    // started before the change, whose prose is already being written from the older trip.
    .replan(tripId, { afterEdit: true })
    // The page shows the new prose only once it re-reads. Same downgrade as everywhere else in
    // this file: a failed re-read is a stale VIEW, never a failed rewrite.
    .then(() => refreshView(deps, tripId))
    .catch(() => {})
}

/**
 * Read a tool's reply the way the activity rail has to: outcome first, prose second.
 *
 * Lives beside the writer so the vocabulary cannot drift between the two ends of it. Two rules
 * carry the safety:
 *
 *  - An outcome is only believed when it is one of `EDIT_VERDICTS`. Anything else — a missing
 *    field, a tool that answers in plain prose, a number — is not evidence of failure and is not
 *    treated as one.
 *  - `detail` is display text and never a claim. It is the reply's own `result` line when there
 *    is one (the rail used to print the whole raw envelope, JSON braces and all), and otherwise
 *    the first line of whatever came back.
 *
 * A caption cannot forge an outcome here. `editResult` builds the object literally and
 * `JSON.stringify` escapes every string field, so caption text lands inside `result` as data; it
 * cannot introduce a sibling key, and a duplicate `outcome` cannot be produced at all.
 */
export function readToolOutcome(value: unknown): { outcome: EditVerdict; detail?: string } {
  if (typeof value !== 'string') return { outcome: 'done' }

  const firstLine = (text: string) => text.split('\n')[0]

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { outcome: 'done', detail: firstLine(value) }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { outcome: 'done', detail: firstLine(value) }
  }

  const envelope = parsed as { result?: unknown; outcome?: unknown }
  const declared = envelope.outcome
  return {
    outcome: EDIT_VERDICTS.includes(declared as EditVerdict) ? (declared as EditVerdict) : 'done',
    detail: firstLine(typeof envelope.result === 'string' ? envelope.result : value),
  }
}

export function movePlaceTool(deps: EditDeps): ToolSpec {
  return {
    name: 'move_place',
    description:
      'Moves a stop to a different day, and optionally to a position within that day. Call it directly and do not ask the user in chat first — Astrail shows them an approval card on the page, and the reply says whether they accepted. Identify the stop by its map-pin number (preferred) or its name. The reply records the day and position it came from. Astrail then rewrites the day summaries to match the new order — do not call replan_trip afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'Pin number (preferred) or place name.' },
        to_day: { type: 'integer', description: 'Day number to move it to.', minimum: 1 },
        to_position: { type: 'integer', description: 'Position within that day, 1 = first.', minimum: 1 },
        trip_id: { type: 'string', description: 'Trip id from list_trips. Omit for the open trip.' },
      },
      required: ['place'],
      additionalProperties: false,
    },
    // Untrusted because the reply names the stop, and `place.name` was extracted from an
    // Instagram caption — text an attacker writes (guardrail #11). A mutation tool is not
    // exempt from the hint just because its own inputs are pin numbers.
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (args) => {
      const r = await resolveBundle(deps.trips, typeof args.trip_id === 'string' ? args.trip_id : undefined)
      if (!r.ok) return noChange('failed', r.message)
      const found = resolvePlaceRef(r.bundle, String(args.place ?? ''))
      if (!found.ok) return noChange('failed', found.message)

      const tp = found.tripPlace
      const toDay = typeof args.to_day === 'number' ? args.to_day : undefined
      const toPos = typeof args.to_position === 'number' ? args.to_position : undefined
      if (toDay === undefined && toPos === undefined) return noChange('failed', 'Give to_day, to_position, or both.')

      const fromDay = tp.day_number
      const patch: { day_number?: number; sort_order?: number } = {}
      if (toDay !== undefined) patch.day_number = toDay
      // The tool speaks 1-based positions because the user counts from 1; the column is 0-based.
      if (toPos !== undefined) patch.sort_order = toPos - 1

      const where = toDay !== undefined ? `day ${toDay}` : `position ${toPos}`
      /* Asked for, at last, and the reason is in the second line of the card rather than in this
         tool's own cost. A move was deliberately cardless while it was a local reorder — the
         rule was "reversible gets an undo, irreversible gets a confirm", and it was the one
         durable edit an agent made on its own initiative. What changed is not the rule but the
         price: every mutation now starts a narration (`startSummaryRewrite`), so a cardless move
         spends an LLM call with nothing on screen having asked. The card says so, because a
         consent card that does not name what it is consenting to is decoration. */
      const approved = await deps.confirm(
        `Move "${tp.place.name}" to ${where} of this trip.\nAstrail will rewrite the day summaries to match, which takes a moment.`,
      )
      if (approved === 'unavailable') return noChange('failed', NO_CARD)
      if (!approved) return noChange('declined', `The user declined. "${tp.place.name}" has not moved.`)

      try {
        await deps.move(r.bundle.trip.id, tp.id, patch)
      } catch (e) {
        return noChange('failed', e instanceof Error ? e.message : 'The move failed.')
      }

      // Started the instant the prose became wrong, and before the re-read below, so the two
      // round-trips overlap rather than queue.
      startSummaryRewrite(deps, r.bundle.trip.id)
      const { fresh, stale } = await refreshView(deps, r.bundle.trip.id)
      // A record of the origin, not a promise about it: a null `sort_order` is a legal row and
      // `to_position` cannot express one, so say the position is missing rather than imply the
      // stop can be restored exactly.
      // `resolvePlaceRef` only ever returns a dayed stop (orderedTripPlaces drops day_number
      // null), so `fromDay` is a number here; the branch just keeps the sentence honest.
      const from = fromDay === null ? 'no day' : `day ${fromDay}`
      const origin =
        tp.sort_order !== null
          ? `It was on ${from} at position ${tp.sort_order + 1}.`
          : `It was on ${from}; its position within that day was not recorded.`
      return editResult({
        result: `The user approved. Moved "${tp.place.name}" to ${where}.${pinsLine(fresh, tp.place.name)} ${origin} ${stale ? STALE_VIEW : 'The map has redrawn.'}`,
        summariesStale: true,
        summariesRewriting: true,
      })
    },
  }
}

export function removePlaceTool(deps: EditDeps): ToolSpec {
  return {
    name: 'remove_place',
    description:
      'Removes a stop from the trip. Call it directly and do not ask the user in chat first — Astrail shows them an approval card on the page, and the reply says whether they accepted. It cannot be undone. Identify the stop by its map-pin number or name. The remaining stops are renumbered, so re-read the itinerary before referring to pin numbers again.',
    inputSchema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'Pin number (preferred) or place name.' },
        trip_id: { type: 'string', description: 'Trip id from list_trips. Omit for the open trip.' },
      },
      required: ['place'],
      additionalProperties: false,
    },
    // Same caption-derived name, on BOTH branches: declining still repeats the stop back.
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (args) => {
      const r = await resolveBundle(deps.trips, typeof args.trip_id === 'string' ? args.trip_id : undefined)
      if (!r.ok) return noChange('failed', r.message)
      const found = resolvePlaceRef(r.bundle, String(args.place ?? ''))
      if (!found.ok) return noChange('failed', found.message)

      const tp = found.tripPlace
      const approved = await deps.confirm(
        `Remove "${tp.place.name}"${tp.day_number ? ` from day ${tp.day_number}` : ''} from this trip.\nThis cannot be undone.`,
      )
      // Never report a success the user did not authorise.
      if (approved === 'unavailable') return noChange('failed', NO_CARD)
      if (!approved) return noChange('declined', `The user declined. "${tp.place.name}" is still on the trip.`)

      try {
        await deps.remove(r.bundle.trip.id, tp.id)
      } catch (e) {
        return noChange('failed', e instanceof Error ? e.message : 'The removal failed.')
      }

      // The case that forced this whole change: a removed stop leaves prose that is not merely
      // incomplete but FALSE — "the day ... ends at Tokyo Tower", about a stop that is gone.
      startSummaryRewrite(deps, r.bundle.trip.id)
      const { stale } = await refreshView(deps, r.bundle.trip.id)
      return editResult({
        result: `The user approved. Removed "${tp.place.name}".${stale ? ` ${STALE_VIEW}` : ''}`,
        summariesStale: true,
        summariesRewriting: true,
        notes: ['The remaining stops have been renumbered — call get_itinerary before using pin numbers again.'],
      })
    },
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function addPlaceTool(deps: EditDeps): ToolSpec {
  return {
    name: 'add_place',
    description:
      'Adds a new stop to a day of the trip. Call it directly and do not ask in chat first; Astrail asks on the page and the reply says whether they accepted. Astrail marks it as one they asked for, with no Reel evidence behind it. Astrail looks the place up itself — first among the trip\'s own stops, then with its map provider — so send the name alone and do not supply coordinates. Only if it replies that it could not resolve the name, retry with lat and lng together.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Place name, e.g. "Universal Studios Japan".' },
        day: { type: 'integer', description: 'Day number to add it to.', minimum: 1 },
        position: { type: 'integer', description: 'Position within the day, 1 = first. Omit to append.', minimum: 1 },
        lat: { type: 'number', description: 'Latitude. Only if asked for; must be paired with lng.' },
        lng: { type: 'number', description: 'Longitude. Only if asked for; must be paired with lat.' },
        // Declared because the executor reads it and this tool is registered globally: away from
        // a trip page it answers "pass its trip_id", and `additionalProperties: false` would have
        // rejected the agent for complying. Every sibling edit tool takes the same parameter.
        trip_id: { type: 'string', description: 'Trip id from list_trips. Omit for the open trip.' },
      },
      required: ['name', 'day'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (args) => {
      const r = await resolveBundle(deps.trips, typeof args.trip_id === 'string' ? args.trip_id : undefined)
      if (!r.ok) return noChange('failed', r.message)

      const name = String(args.name ?? '').trim()
      if (!name) return noChange('failed', 'What place should be added?')
      const day = typeof args.day === 'number' ? args.day : null
      if (day === null) return noChange('failed', 'Which day should it go on?')

      const hasLat = typeof args.lat === 'number'
      const hasLng = typeof args.lng === 'number'
      if (hasLat !== hasLng) return noChange('failed', 'Give both lat and lng, or neither.')

      // Coordinates the AGENT supplied are shown, because they are the one thing on this card the
      // user cannot otherwise check. Astrail looks a name up itself and verifies what comes back;
      // a lat/lng passed straight in is model-asserted, and the backend can only confirm it is
      // somewhere near this trip — not that it is the place named. Approving a pin you were never
      // shown is how a wrong landmark gets into an itinerary silently. Four decimals is ~11 m.
      const pin = hasLat && hasLng
        ? `\nIt will be pinned at ${(args.lat as number).toFixed(4)}, ${(args.lng as number).toFixed(4)} — coordinates I supplied rather than ones Astrail looked up. Check them before accepting.`
        : ''
      const approved = await deps.confirm(
        `Add "${name}" to day ${day} of this trip.\nIt will be marked as a place you asked for, with no Reel evidence behind it.${pin}`,
      )
      if (approved === 'unavailable') return noChange('failed', NO_CARD)
      if (!approved) return noChange('declined', `The user declined. "${name}" was not added.`)

      try {
        await deps.add(r.bundle.trip.id, {
          name,
          day_number: day,
          position: typeof args.position === 'number' ? args.position : null,
          lat: hasLat ? (args.lat as number) : null,
          lng: hasLng ? (args.lng as number) : null,
        })
      } catch (e) {
        return noChange('failed', e instanceof Error ? e.message : 'Adding the place failed.')
      }

      startSummaryRewrite(deps, r.bundle.trip.id)
      const { fresh, stale } = await refreshView(deps, r.bundle.trip.id)
      return editResult({
        result: `The user approved. Added "${name}" to day ${day}.${pinsLine(fresh, name)}${stale ? ` ${STALE_VIEW}` : ''}`,
        summariesStale: true,
        summariesRewriting: true,
        notes: ['Pin numbers have shifted — call get_itinerary before using them again.'],
      })
    },
  }
}

export function setTripDatesTool(deps: EditDeps): ToolSpec {
  return {
    name: 'set_trip_dates',
    description:
      'Changes when the trip happens. Call it directly and do not ask the user in chat first — Astrail shows them an approval card on the page, and the reply says whether they accepted. Each day keeps its stops and its position, so day 2 stays day 2 and only its date moves. Give start_date, end_date, or both, as YYYY-MM-DD. If the new range is too short for the days that already exist, Astrail refuses rather than dropping a day.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'New start date, YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'New end date, YYYY-MM-DD.' },
        trip_id: { type: 'string', description: 'Trip id from list_trips. Omit for the open trip.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: async (args) => {
      const r = await resolveBundle(deps.trips, typeof args.trip_id === 'string' ? args.trip_id : undefined)
      if (!r.ok) return noChange('failed', r.message)

      const start = typeof args.start_date === 'string' ? args.start_date : null
      const end = typeof args.end_date === 'string' ? args.end_date : null
      if (!start && !end) return noChange('failed', 'Give start_date, end_date, or both, as YYYY-MM-DD.')
      for (const [label, value] of [['start_date', start], ['end_date', end]] as const) {
        if (value && !ISO_DATE.test(value)) return noChange('failed', `${label} must be YYYY-MM-DD.`)
      }
      if (start && end && end < start) return noChange('failed', 'end_date is before start_date.')

      const from = `${r.bundle.trip.start_date ?? '?'} to ${r.bundle.trip.end_date ?? '?'}`
      const to = `${start ?? r.bundle.trip.start_date ?? '?'} to ${end ?? r.bundle.trip.end_date ?? '?'}`
      const approved = await deps.confirm(`Move this trip from ${from} to ${to}.\nEvery day keeps its stops; only the dates change.`)
      if (approved === 'unavailable') return noChange('failed', NO_CARD)
      if (!approved) return noChange('declined', 'The user declined. The dates are unchanged.')

      try {
        await deps.setDates(r.bundle.trip.id, { start_date: start, end_date: end })
      } catch (e) {
        return noChange('failed', e instanceof Error ? e.message : 'Changing the dates failed.')
      }

      // Moving the dates does not touch a stop — `edit_trip_dates` writes only
      // `trip_days.day_date` and `trips.start_date`/`end_date` — which is why this tool used to
      // report the summaries as intact. But the stops are not the only thing the prose is written
      // FROM: `persist_narration` hands the narrator each day's DATE alongside its stops
      // (`build_narrator_input`: "Day 2 (2026-08-28)"), so a summary written for a late-August
      // Saturday is prose about a day this trip no longer has. Every change gets its rewrite;
      // this one was named explicitly.
      //
      // The weather line is the exception, and the rewrite makes it worse rather than better.
      // `persist_weather` runs only inside the generation pipeline; `/trips/{id}/replan` calls
      // `_refresh_trip_routes` + `persist_narration` only, and `persist_narration` feeds
      // `weather_summary` straight to the narrator. So the rewrite reads a forecast for the OLD
      // dates and can launder it into freshly-written prose. Nothing reachable from here fixes
      // that — refreshing the forecast means calling the weather agent inside the replan endpoint
      // — so the note is what keeps it visible, and it now says the summaries were written from it.
      // Falls back to the PRE-edit bundle when the re-read failed: changing the dates does not
      // write a weather row, so the old bundle answers "does this trip carry a forecast" just as
      // well — and dropping the warning because a GET failed would lose it silently.
      startSummaryRewrite(deps, r.bundle.trip.id)
      const { fresh, stale } = await refreshView(deps, r.bundle.trip.id)
      const hasWeather = (fresh ?? r.bundle).days.some((d) => d.weather_summary)
      return editResult({
        result: `The user approved. The trip now runs ${to}. Every day kept its stops and its number.${stale ? ` ${STALE_VIEW}` : ''}`,
        summariesStale: true,
        summariesRewriting: true,
        notes: hasWeather
          ? ['The weather note on each day is still the forecast for the old dates, nothing refreshes it, and the rewritten summaries are written from it.']
          : [],
      })
    },
  }
}

export function replanTripTool(deps: EditDeps): ToolSpec {
  return {
    name: 'replan_trip',
    description:
      'Rewrites the trip description and day summaries so they match the stops the trip has now, and recalculates the routes. Every edit already starts this by itself, so do NOT call it after one — only when the user asks for the wording to be refreshed, or after a rewrite failed. Call it directly; Astrail asks on the page, so do not ask in chat first. It costs nothing from the trip allowance, and if this page already has a rewrite running it waits for that one rather than starting a second.',
    inputSchema: {
      type: 'object',
      properties: { trip_id: { type: 'string', description: 'Trip id from list_trips. Omit for the open trip.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: async (args) => {
      const r = await resolveBundle(deps.trips, typeof args.trip_id === 'string' ? args.trip_id : undefined)
      if (!r.ok) return noChange('failed', r.message)

      const dayCount = r.bundle.days.length
      /* Whether this call would START work, or merely wait for work already under way.
         On the joining branch nothing yields between this read and `deps.replan` below, and that
         is deliberate: the in-flight set is only ever mutated in a promise continuation, so with
         no await in the gap a rewrite cannot finish there and turn a join into a fresh narration
         the user was never asked about. The other branch awaits the card, and a rewrite starting
         while the card is up is harmless — `deps.replan` joins that one too. */
      const joining = deps.replanInFlight?.(r.bundle.trip.id) === true

      // Approval, for the one shape of this call that is still a decision. An agent asking to
      // rewrite prose the user may have read, off its own initiative, is a decision. Joining a
      // rewrite that an edit already started is not: the work is running and cannot be called
      // back, so a card there offers a choice that does not exist — and answering "no" to it
      // would be followed by the summaries changing anyway, which is the exact class of lie the
      // outcome field exists to stop.
      //
      // The cost sentence used to read "This uses your credit". It never did: `/trips/{id}/replan`
      // (backend/main.py) carries the burst limiter and an editable-trip check and nothing else —
      // no quota reserve, no entitlement read, unlike `generate-trip`. The agent repeated that
      // invented cost back at the user as a reason to decline the rewrite the trip needed.
      if (!joining) {
        const approved = await deps.confirm(
          `Rewrite the day summaries for this trip so they match its current stops.\n${dayCount} day${dayCount === 1 ? '' : 's'} will be re-described. This does not use a trip from your allowance.`,
        )
        if (approved === 'unavailable') return noChange('failed', NO_CARD)
        if (!approved) return noChange('declined', 'The user declined. The summaries are unchanged.')
      }

      let result: { days_narrated: number; routes_refreshed: boolean }
      try {
        result = await deps.replan(r.bundle.trip.id)
      } catch (e) {
        return noChange('failed', e instanceof Error ? e.message : 'Replanning failed.')
      }

      const { stale } = await refreshView(deps, r.bundle.trip.id)
      const routes = result.routes_refreshed ? 'Routes recalculated.' : 'Routes could not be recalculated this time.'
      /* An edit that landed WHILE this rewrite ran leaves the prose behind again the moment it
         finishes, and the shell has already started the follow-up that fixes it. Saying
         `summaries_stale: false` here because a rewrite completed would be the stale-join lie one
         level up: what makes the summaries current is that no newer edit exists, not that a
         narration returned. This is the only reading of it that the tool can make after the fact,
         and it is exact — the shell clears `running` before this continuation resumes, so a
         rewrite in flight NOW is by construction one that a later edit asked for. */
      const overtaken = deps.replanInFlight?.(r.bundle.trip.id) === true
      // The one success path here that used to answer in bare prose. Its three other endings now
      // answer in the envelope, and a reply whose SHAPE depends on how it went is a second thing
      // the reader has to know before it can read the first.
      return editResult({
        // Who asked for it is part of the record, and on the join path it was not the user: an
        // edit started this rewrite and this call only waited for it.
        result: `${joining ? 'Joined the rewrite this trip already had running.' : 'The user approved.'} Rewrote ${result.days_narrated} day summar${result.days_narrated === 1 ? 'y' : 'ies'} to match the current stops.${overtaken ? ' The trip changed again while it ran, so another rewrite is already under way.' : ''} ${routes}${stale ? ` ${STALE_VIEW}` : ''}`,
        // This is the tool that un-stales them — unless an edit overtook it, in which case the
        // prose it just wrote is already one edit behind and saying otherwise is the lie.
        summariesStale: overtaken,
        summariesRewriting: overtaken,
      })
    },
  }
}
