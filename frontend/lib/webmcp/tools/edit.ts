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
