import type { TripBundle, TripPlace } from '@/lib/trip/backend-types'
import { buildTrailNumbers, orderedTripPlaces } from '@/lib/trip/selectors'

/**
 * Resolving a place the agent named, without ever putting a UUID in the agent's vocabulary.
 *
 * Two reasons this matters more than it looks:
 *
 * 1. Budget. 18 stops x 36-char UUID is 648 characters — 43% of a tool's entire output budget
 *    spent on identifiers the agent cannot say out loud. Pin numbers cost 1-2 characters.
 * 2. Shared reference. The map already paints a number on every pin. When the agent says
 *    "moving stop 7", the user's eye goes to pin 7. The agent and the human are pointing at
 *    the same thing — which is the whole premise of collaborating on one map.
 *
 * So a `place_ref` is a pin number ("7") or a name ("Fushimi Inari"), and ambiguity returns
 * candidates rather than a guess. Guessing here silently edits the wrong stop.
 */

export type ResolveOk = { ok: true; tripPlace: TripPlace; pin: number | null }
export type ResolveErr = { ok: false; message: string }
export type ResolveResult = ResolveOk | ResolveErr

/** Case-, accent- and punctuation-insensitive. "tenryu-ji" must match "Tenryū-ji". */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function describe(tp: TripPlace, pins: Map<string, number>): string {
  const pin = pins.get(tp.id)
  const day = tp.day_number == null ? 'unscheduled' : `day ${tp.day_number}`
  return `${pin ?? '-'} ${tp.place.name} (${day})`
}

/**
 * Resolve a `place_ref` against the in-memory bundle.
 *
 * Match order is deliberate — most specific first, so an exact name never loses to a
 * substring hit on a longer one:
 *   pin number -> exact name -> exact local name/alias -> unique substring
 */
export function resolvePlaceRef(bundle: TripBundle, ref: string): ResolveResult {
  const raw = ref.trim()
  if (!raw) return { ok: false, message: 'No place given. Use a pin number from get_itinerary, or a place name.' }

  const pins = buildTrailNumbers(bundle)
  const all = orderedTripPlaces(bundle)
  if (all.length === 0) return { ok: false, message: 'This trip has no stops yet.' }

  // 1. Pin number — the preferred form, and the one the user can see on the map.
  if (/^\d+$/.test(raw)) {
    const wanted = Number(raw)
    const hit = all.find((tp) => pins.get(tp.id) === wanted)
    if (hit) return { ok: true, tripPlace: hit, pin: wanted }
    return {
      ok: false,
      message: `There is no stop ${wanted}. This trip has stops 1-${all.length}.`,
    }
  }

  const needle = normalize(raw)

  // 2. Exact name.
  const exact = all.filter((tp) => normalize(tp.place.name) === needle)
  if (exact.length === 1) return { ok: true, tripPlace: exact[0], pin: pins.get(exact[0].id) ?? null }
  if (exact.length > 1) {
    return {
      ok: false,
      message: `"${raw}" matches ${exact.length} stops: ${exact.map((tp) => describe(tp, pins)).join(', ')}. Use the pin number.`,
    }
  }

  // 3. Local-script name or a recorded alias — reel captions often use these.
  const aliased = all.filter(
    (tp) =>
      (tp.place.name_local != null && normalize(tp.place.name_local) === needle) ||
      tp.place.aliases.some((a) => normalize(a) === needle),
  )
  if (aliased.length === 1) return { ok: true, tripPlace: aliased[0], pin: pins.get(aliased[0].id) ?? null }

  // 4. Substring — only when it is unambiguous.
  const partial = all.filter((tp) => normalize(tp.place.name).includes(needle))
  if (partial.length === 1) return { ok: true, tripPlace: partial[0], pin: pins.get(partial[0].id) ?? null }
  if (partial.length > 1) {
    return {
      ok: false,
      message: `"${raw}" is ambiguous — did you mean ${partial.slice(0, 5).map((tp) => describe(tp, pins)).join(', ')}? Use the pin number.`,
    }
  }

  return {
    ok: false,
    message: `No stop matches "${raw}". Call get_itinerary to see the stops and their pin numbers.`,
  }
}
