import type { PlaceSourceType, TripBundle, TripPlace } from '@/lib/trip/backend-types'
import {
  buildTrailNumbers,
  orderedDays,
  placesForDay,
  recommendedHotelId,
  selectedHotel,
} from '@/lib/trip/selectors'
import { fitBlocks } from './fit'

/**
 * Compact, agent-readable renderings of a trip.
 *
 * Text, not JSON. The same content as JSON costs 35-45% more in braces, quotes and repeated
 * keys, and output is the scarce resource (~1.5K per call) while tool descriptions are free
 * and sent once. So the legend for `reel`/`you`/`astrail` lives in the tool DESCRIPTION and
 * never in the output — spending output bytes re-explaining a legend on every call is the
 * easiest budget mistake to make.
 */

const SOURCE_LABEL: Record<PlaceSourceType, string> = {
  reel_extracted: 'reel',
  user_requested: 'you',
  agent_suggested: 'astrail',
}

/** "Mar 3-7" — the shortest form that is still unambiguous to a human reading the chat. */
function dateRange(start: string | null, end: string | null): string | null {
  if (!start) return null
  const fmt = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`)
    if (Number.isNaN(d.getTime())) return iso
    return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`
  }
  if (!end || end === start) return fmt(start)
  const [s, e] = [fmt(start), fmt(end)]
  const sameMonth = s.split(' ')[0] === e.split(' ')[0]
  return sameMonth ? `${s}-${e.split(' ')[1]}` : `${s} - ${e}`
}

function stopLine(tp: TripPlace, pin: number | undefined): string {
  const name = tp.place.name
  const src = SOURCE_LABEL[tp.source_type] ?? 'astrail'
  return ` ${pin ?? '-'} ${name} · ${src}`
}

export function tripHeader(bundle: TripBundle): string {
  const { trip } = bundle
  const where = trip.title ?? trip.inferred_destination ?? trip.destination_hint ?? 'Trip'
  const when = dateRange(trip.start_date, trip.end_date)
  const dayCount = orderedDays(bundle).length
  const stopCount = buildTrailNumbers(bundle).size
  return [
    where,
    when,
    dayCount ? `${dayCount} days` : null,
    `${stopCount} stops`,
    trip.status,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The whole trip, or one day in full.
 *
 * Degrades at DAY boundaries only (see fit.ts): a truncated day would read to the agent as a
 * complete day that happens to be empty in the afternoon, and it would tell the user so.
 */
export function formatItinerary(bundle: TripBundle, day?: number): string {
  const pins = buildTrailNumbers(bundle)
  const days = orderedDays(bundle)
  const wanted = day == null ? days : days.filter((d) => d.day_number === day)

  if (day != null && wanted.length === 0) {
    const range = days.length ? `1-${days.length}` : 'none'
    return `This trip has no day ${day}. Days: ${range}.`
  }

  const blocks = wanted.map((d) => {
    const stops = placesForDay(bundle, d.day_number)
    const title = d.title ? ` ${d.title}` : ''
    // Weather is the first thing dropped under budget pressure, so it rides on the day line.
    const weather = d.weather_summary ? ` (${d.weather_summary})` : ''
    return {
      key: String(d.day_number),
      lines: [
        `D${d.day_number}${title}${weather}`,
        ...(stops.length
          ? stops.map((tp) => stopLine(tp, pins.get(tp.id)))
          : ['  (no stops yet)']),
      ],
    }
  })

  const footer: string[] = []
  const hotel = selectedHotel(bundle, recommendedHotelId(bundle))
  if (hotel) footer.push(`Stay: ${hotel.name} (recommended)`)
  const gaps = bundle.trip.tradeoffs?.notes?.filter((n) => n.severity !== 'info') ?? []
  if (gaps.length) footer.push(`Gaps: ${gaps.slice(0, 2).map((g) => g.detail).join('; ')}`)

  return fitBlocks({
    header: tripHeader(bundle),
    blocks,
    footer,
    continuation: (dropped) =>
      `…days ${dropped.join(',')} omitted — call get_itinerary(day:${dropped[0]}) for those`,
  })
}

/** One line per trip, newest first. Capped — a long list is noise, not context. */
export function formatTripList(
  trips: { id: string; title: string | null; inferred_destination: string | null; destination_hint: string | null; start_date: string | null; end_date: string | null; status: string }[],
  cap = 12,
): string {
  if (trips.length === 0) return 'No trips yet. Save some Instagram Reels, then plan a trip from them.'
  const shown = trips.slice(0, cap)
  const lines = shown.map((t, i) => {
    const where = t.title ?? t.inferred_destination ?? t.destination_hint ?? 'Untitled'
    const when = dateRange(t.start_date, t.end_date)
    return `${i + 1} ${where}${when ? ` · ${when}` : ''} · ${t.status} · id=${t.id.slice(0, 8)}`
  })
  if (trips.length > cap) lines.push(`…and ${trips.length - cap} more`)
  return `${trips.length} trip${trips.length === 1 ? '' : 's'}\n${lines.join('\n')}`
}
