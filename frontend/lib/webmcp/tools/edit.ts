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
 * Reversibility decides the interaction: `move_place` is trivially undoable, so it just reports
 * where the stop came from and the agent can move it back. `remove_place` is not, so it asks.
 */

export type EditDeps = {
  trips: TripReader
  add: (tripId: string, body: { name: string; day_number: number; position?: number | null; lat?: number | null; lng?: number | null }) => Promise<unknown>
  setDates: (tripId: string, body: { start_date?: string | null; end_date?: string | null }) => Promise<unknown>
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

export function movePlaceTool(deps: EditDeps): ToolSpec {
  return {
    name: 'move_place',
    description:
      'Moves a stop to a different day, and optionally to a position within that day. Applies straight away and the map redraws. Identify the stop by its map-pin number (preferred) or its name. The reply says where the stop came from, so you can move it back if the user changes their mind.',
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
    annotations: { readOnlyHint: false, untrustedContentHint: false },
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
      return `Moved "${tp.place.name}" to ${where}.${pinsLine(fresh, tp.place.name)} It was on day ${fromDay ?? 'none'}${
        tp.sort_order !== null ? ` at position ${tp.sort_order + 1}` : ''
      }, so you can put it back if the user prefers. The map has redrawn.`
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
    annotations: { readOnlyHint: false, untrustedContentHint: false },
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
      return `The user approved. Removed "${tp.place.name}". The remaining stops have been renumbered — call get_itinerary before using pin numbers again.`
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
      return `The user approved. Added "${name}" to day ${day}.${pinsLine(fresh, name)} Pin numbers have shifted — call get_itinerary before using them again.`
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

      await deps.refresh(r.bundle.trip.id)
      return `The user approved. The trip now runs ${to}. Every day kept its stops and its number.`
    },
  }
}
