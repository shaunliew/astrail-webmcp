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
  replan: (tripId: string) => Promise<{ days_narrated: number; routes_refreshed: boolean }>
  move: (tripId: string, tripPlaceId: string, patch: { day_number?: number; sort_order?: number }) => Promise<unknown>
  remove: (tripId: string, tripPlaceId: string) => Promise<unknown>
  /** Re-reads the trip so the page reflects the change before the tool reports success. */
  refresh: (tripId: string) => Promise<TripBundle | null>
  confirm: (summary: string) => Promise<boolean>
}

/** Renumbering after an edit is the point of pin numbers: they must describe what is on screen now. */
function pinsLine(bundle: TripBundle | null, name: string): string {
  if (!bundle) return ''
  const pin = [...buildTrailNumbers(bundle).entries()].find(
    ([id]) => bundle.places.find((p) => p.id === id)?.place.name === name,
  )?.[1]
  return pin ? ` It is now stop ${pin}.` : ''
}

type EditOutcome = {
  /** What happened, in the words the agent repeats to the user. */
  result: string
  /** True when the persisted summaries now describe stops the trip no longer has. */
  summariesStale: boolean
  /** Anything the agent must act on before its next call — renumbering, a stale forecast. */
  notes?: string[]
}

/**
 * The answer to a completed edit, as fields rather than a sentence.
 *
 * Reported from real use: a stop was added and the trip description and day plan still described
 * the itinerary without it. `replan_trip` already did that job; nothing told the agent to call it
 * at the moment it mattered. It goes stale because the prose is written FROM the stops — the
 * narrator's input is each day's ordered stop list (`backend/genagents/narrator.py`,
 * `build_narrator_input`) — while every edit endpoint refreshes routes and leaves
 * `trip_days.summary` alone. Nothing else in the system notices.
 *
 * Structured, not prose: `plan_trip_from_reels` returns `next_tool` for exactly this reason —
 * agents follow a named field far more reliably than the same instruction inside a sentence.
 *
 * It TELLS and never does. `replan_trip` spends the user credit and raises its own approval
 * card, so triggering it here would spend on the agent's initiative.
 */
function editResult(outcome: EditOutcome): string {
  const notes = [
    ...(outcome.notes ?? []),
    ...(outcome.summariesStale
      ? ['The day and trip summaries still describe the itinerary before this edit.']
      : []),
  ]
  return JSON.stringify({
    result: outcome.result,
    summaries_stale: outcome.summariesStale,
    ...(outcome.summariesStale ? { next_tool: 'replan_trip' } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  })
}

export function movePlaceTool(deps: EditDeps): ToolSpec {
  return {
    name: 'move_place',
    description:
      'Moves a stop to a different day, and optionally to a position within that day. Applies straight away and the map redraws. Identify the stop by its map-pin number (preferred) or its name. The reply records the day and position it came from, and names the tool that brings the day summaries back in line with the new order.',
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
      if (!r.ok) return r.message
      const found = resolvePlaceRef(r.bundle, String(args.place ?? ''))
      if (!found.ok) return found.message

      const tp = found.tripPlace
      const toDay = typeof args.to_day === 'number' ? args.to_day : undefined
      const toPos = typeof args.to_position === 'number' ? args.to_position : undefined
      if (toDay === undefined && toPos === undefined) return 'Give to_day, to_position, or both.'

      const fromDay = tp.day_number
      const patch: { day_number?: number; sort_order?: number } = {}
      if (toDay !== undefined) patch.day_number = toDay
      // The tool speaks 1-based positions because the user counts from 1; the column is 0-based.
      if (toPos !== undefined) patch.sort_order = toPos - 1

      try {
        await deps.move(r.bundle.trip.id, tp.id, patch)
      } catch (e) {
        return e instanceof Error ? e.message : 'The move failed.'
      }

      const fresh = await deps.refresh(r.bundle.trip.id)
      const where = toDay !== undefined ? `day ${toDay}` : `position ${toPos}`
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
        result: `Moved "${tp.place.name}" to ${where}.${pinsLine(fresh, tp.place.name)} ${origin} The map has redrawn.`,
        summariesStale: true,
      })
    },
  }
}

export function removePlaceTool(deps: EditDeps): ToolSpec {
  return {
    name: 'remove_place',
    description:
      'Removes a stop from the trip. This cannot be undone, so it shows the user an approval card first and only removes it if they accept. Identify the stop by its map-pin number or name. The remaining stops are renumbered, so re-read the itinerary before referring to pin numbers again.',
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
      if (!r.ok) return r.message
      const found = resolvePlaceRef(r.bundle, String(args.place ?? ''))
      if (!found.ok) return found.message

      const tp = found.tripPlace
      const approved = await deps.confirm(
        `Remove "${tp.place.name}"${tp.day_number ? ` from day ${tp.day_number}` : ''} from this trip.\nThis cannot be undone.`,
      )
      // Never report a success the user did not authorise.
      if (!approved) return `The user declined. "${tp.place.name}" is still on the trip.`

      try {
        await deps.remove(r.bundle.trip.id, tp.id)
      } catch (e) {
        return e instanceof Error ? e.message : 'The removal failed.'
      }

      await deps.refresh(r.bundle.trip.id)
      return editResult({
        result: `The user approved. Removed "${tp.place.name}".`,
        summariesStale: true,
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
      'Adds a new stop to a day of the trip. The user approves it on the page first. Astrail marks it as one they asked for, with no Reel evidence behind it. If the name cannot be matched to a location Astrail already knows, it will ask you for coordinates rather than guess — pass lat and lng together in that case.',
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
      if (!r.ok) return r.message

      const name = String(args.name ?? '').trim()
      if (!name) return 'What place should be added?'
      const day = typeof args.day === 'number' ? args.day : null
      if (day === null) return 'Which day should it go on?'

      const hasLat = typeof args.lat === 'number'
      const hasLng = typeof args.lng === 'number'
      if (hasLat !== hasLng) return 'Give both lat and lng, or neither.'

      const approved = await deps.confirm(
        `Add "${name}" to day ${day} of this trip.\nIt will be marked as a place you asked for, with no Reel evidence behind it.`,
      )
      if (!approved) return `The user declined. "${name}" was not added.`

      try {
        await deps.add(r.bundle.trip.id, {
          name,
          day_number: day,
          position: typeof args.position === 'number' ? args.position : null,
          lat: hasLat ? (args.lat as number) : null,
          lng: hasLng ? (args.lng as number) : null,
        })
      } catch (e) {
        return e instanceof Error ? e.message : 'Adding the place failed.'
      }

      const fresh = await deps.refresh(r.bundle.trip.id)
      return editResult({
        result: `The user approved. Added "${name}" to day ${day}.${pinsLine(fresh, name)}`,
        summariesStale: true,
        notes: ['Pin numbers have shifted — call get_itinerary before using them again.'],
      })
    },
  }
}

export function setTripDatesTool(deps: EditDeps): ToolSpec {
  return {
    name: 'set_trip_dates',
    description:
      'Changes when the trip happens. Each day keeps its stops and its position, so day 2 stays day 2 and only its date moves. Give start_date, end_date, or both, as YYYY-MM-DD. If the new range is too short for the days that already exist, Astrail refuses rather than dropping a day.',
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
      if (!r.ok) return r.message

      const start = typeof args.start_date === 'string' ? args.start_date : null
      const end = typeof args.end_date === 'string' ? args.end_date : null
      if (!start && !end) return 'Give start_date, end_date, or both, as YYYY-MM-DD.'
      for (const [label, value] of [['start_date', start], ['end_date', end]] as const) {
        if (value && !ISO_DATE.test(value)) return `${label} must be YYYY-MM-DD.`
      }
      if (start && end && end < start) return 'end_date is before start_date.'

      const from = `${r.bundle.trip.start_date ?? '?'} to ${r.bundle.trip.end_date ?? '?'}`
      const to = `${start ?? r.bundle.trip.start_date ?? '?'} to ${end ?? r.bundle.trip.end_date ?? '?'}`
      const approved = await deps.confirm(`Move this trip from ${from} to ${to}.\nEvery day keeps its stops; only the dates change.`)
      if (!approved) return 'The user declined. The dates are unchanged.'

      try {
        await deps.setDates(r.bundle.trip.id, { start_date: start, end_date: end })
      } catch (e) {
        return e instanceof Error ? e.message : 'Changing the dates failed.'
      }

      const fresh = await deps.refresh(r.bundle.trip.id)
      // The ONE mutation here that does not stale the summaries, and it is a code fact, not an
      // assumption: `edit_trip_dates` writes only `trip_days.day_date` and
      // `trips.start_date`/`end_date` — no stop, no day_number, no summary. The narrator writes
      // each summary from that day's ordered stop list, so prose about the stops still holds and
      // a replan here would spend the user credit rewriting text that was already right.
      //
      // The weather line is the exception, and `replan_trip` cannot fix it either:
      // `persist_weather` runs only inside the generation pipeline, and `/trips/{id}/replan` calls
      // `_refresh_trip_routes` + `persist_narration` only. Re-narrating would relaunder a forecast
      // for the old dates into freshly-written prose — worse than leaving it visibly old. So say it.
      const hasWeather = fresh?.days.some((d) => d.weather_summary) ?? false
      return editResult({
        result: `The user approved. The trip now runs ${to}. Every day kept its stops and its number.`,
        summariesStale: false,
        notes: [
          'The summaries describe the stops, which did not change, so replan_trip is not needed.',
          ...(hasWeather
            ? ['The weather note on each day is still the forecast for the old dates, and nothing refreshes it.']
            : []),
        ],
      })
    },
  }
}

export function replanTripTool(deps: EditDeps): ToolSpec {
  return {
    name: 'replan_trip',
    description:
      'Rewrites the trip description and the day-by-day summaries so they match the stops the trip actually has now, and recalculates the routes. Use this after adding, moving or removing stops, because the existing summaries still describe the old itinerary. The user approves it first, since rewriting costs them credit. Routes alone already refresh on every edit; this is only needed for the wording.',
    inputSchema: {
      type: 'object',
      properties: { trip_id: { type: 'string', description: 'Trip id from list_trips. Omit for the open trip.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: async (args) => {
      const r = await resolveBundle(deps.trips, typeof args.trip_id === 'string' ? args.trip_id : undefined)
      if (!r.ok) return r.message

      const dayCount = r.bundle.days.length
      // Approval is not optional: this rewrites prose the user may have read, and it spends
      // model credit. An agent must not be able to trigger it on its own initiative.
      const approved = await deps.confirm(
        `Rewrite the day summaries for this trip so they match its current stops.\n${dayCount} day${dayCount === 1 ? '' : 's'} will be re-described. This uses your credit.`,
      )
      if (!approved) return 'The user declined. The summaries are unchanged.'

      let result: { days_narrated: number; routes_refreshed: boolean }
      try {
        result = await deps.replan(r.bundle.trip.id)
      } catch (e) {
        return e instanceof Error ? e.message : 'Replanning failed.'
      }

      await deps.refresh(r.bundle.trip.id)
      const routes = result.routes_refreshed ? 'Routes recalculated.' : 'Routes could not be recalculated this time.'
      return `The user approved. Rewrote ${result.days_narrated} day summar${result.days_narrated === 1 ? 'y' : 'ies'} to match the current stops. ${routes}`
    },
  }
}
