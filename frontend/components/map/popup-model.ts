import type { TripBundle, TripPlace } from '@/lib/trip/backend-types'
import {
  buildPlaceIndex,
  buildTrailNumbers,
  legsForDay,
  orderedDays,
  placesForDay,
  restaurantsForDay,
} from '@/lib/trip/selectors'

/**
 * What a stop's popup says.
 *
 * Deliberately NOT a Google-Maps card. A generic place card answers "what is this?"; a traveller
 * looking at a generated itinerary is asking "why is this on MY trip, and what do I do when I get
 * there?". So everything here is trip-relative: where the stop sits in the day, what the day is
 * about, how you arrive from the previous stop, and what is worth eating nearby.
 *
 * Every field is derived from data we actually hold. Nothing is invented — see the note on
 * opening hours below.
 */

export type PopupModel = {
  eyebrow: string
  title: string
  /** Local-script name, only when it genuinely differs from the title. */
  subtitle: string | null
  where: string | null
  /** Reel thumbnail, when this stop came from a Reel we still have cached. */
  imageUrl: string | null
  /** The trip-relative "what you're doing here" lines. */
  context: string[]
  /** Where to eat around this stop, nearest-anchored first. */
  eats: { name: string; note: string | null }[]
  evidenceLabel: string
  evidence: string
  confidence: number | null
  /** Always an Instagram Reel when one can be attributed. Never a scraped website. */
  reel: { url: string; label: string } | null
  /** A research/official link, shown quietly and never called a Reel. */
  reference: { url: string; label: string } | null
}

const INSTAGRAM_HOST = /(^|\.)instagram\.com$/i

function isInstagram(raw: string | null): boolean {
  if (!raw) return false
  try {
    return INSTAGRAM_HOST.test(new URL(raw).hostname)
  } catch {
    return false
  }
}

/**
 * Caption text arrives with search/pin emoji glued to the front ("🔍梅田藍天大樓展望台",
 * "📍Dekasan …"). Those are artifacts of how people write Reel captions, not part of the name.
 */
function cleanName(raw: string): string {
  return raw
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍\s]+/u, '')
    .replace(/\s+/g, ' ')
    .trim() || raw.trim()
}

function humanDuration(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

const MODE_VERB: Record<string, string> = {
  walk: 'walk', walking: 'walk', drive: 'drive', driving: 'drive',
  transit: 'by transit', cycling: 'cycle', bike: 'cycle',
}

/** A place is "from a Reel" when its evidence came from one — that is the link worth showing. */
function isReelEvidence(kind: string): boolean {
  return kind === 'reel_quote'
}

export function buildPopupModel(bundle: TripBundle, tripPlace: TripPlace): PopupModel {
  const pin = buildTrailNumbers(bundle).get(tripPlace.id) ?? null
  const placeIndex = buildPlaceIndex(bundle)
  const place = tripPlace.place
  const e = tripPlace.evidence_json
  const day = tripPlace.day_number

  const title = cleanName(place.name)
  const localName = place.name_local ? cleanName(place.name_local) : null

  const eyebrow = [
    pin === null ? 'Place' : `Stop ${pin}`,
    day === null ? 'Unscheduled' : `Day ${day}`,
    place.place_type.replace(/_/g, ' '),
  ].join(' · ')

  const where = [place.area, place.city].filter(Boolean).join(', ') || place.country || null

  // ---- Trip-relative context: the part a generic map card cannot give you ----
  const context: string[] = []
  if (day !== null) {
    const stops = placesForDay(bundle, day)
    const index = stops.findIndex((s) => s.id === tripPlace.id)
    const dayMeta = orderedDays(bundle).find((d) => d.day_number === day)
    if (index >= 0) {
      const theme = dayMeta?.title ? ` — “${dayMeta.title}”` : ''
      context.push(`Stop ${index + 1} of ${stops.length} on Day ${day}${theme}`)
    }

    // How you get here from the stop before it.
    if (index > 0 && dayMeta) {
      const prev = stops[index - 1]
      const leg = legsForDay(bundle, dayMeta.id).find(
        (l) => l.to_place_id === place.id && l.from_place_id === prev.place.id,
      )
      if (leg?.duration_seconds) {
        const verb = MODE_VERB[leg.transport_mode] ?? leg.transport_mode
        const dist = leg.distance_meters ? ` (${(leg.distance_meters / 1000).toFixed(1)} km)` : ''
        context.push(`${humanDuration(leg.duration_seconds)} ${verb} from ${cleanName(prev.place.name)}${dist}`)
      }
    }


  }

  // ---- Where to eat ----
  // The trip panel already lists the day's restaurants, but the map is where someone asks
  // "what's around HERE". `near_place_id` exists precisely to tie a suggestion to a stop, so
  // anchor to this place first and fall back to the rest of the day — the answer to "where do I
  // eat" should not depend on which panel you happen to be looking at.
  const eats: PopupModel['eats'] = []
  if (day !== null) {
    const dayMeta = orderedDays(bundle).find((d) => d.day_number === day)
    if (dayMeta) {
      const forDay = restaurantsForDay(bundle, dayMeta.id)
      const anchored = forDay.filter((r) => r.near_place_id === place.id)
      const rest = forDay.filter((r) => r.near_place_id !== place.id)
      for (const r of [...anchored, ...rest].slice(0, 3)) {
        const named = r.restaurant_place_id ? placeIndex.get(r.restaurant_place_id)?.name : null
        eats.push({
          name: named ? cleanName(named) : r.summary,
          note: r.cuisine ?? null,
        })
      }
    }
  }

  // ---- Provenance ----
  const fromReel = isReelEvidence(e.evidence_kind)
  const evidenceLabel = e.quote && fromReel ? 'From your Instagram Reel' : 'Why it is here'
  const evidence =
    e.quote ?? e.rationale ?? 'No caption quote is available for this stop.'

  // The traveller saved a Reel, not a restaurant's homepage. So the primary link is ALWAYS the
  // Instagram Reel when one can be attributed, and a scraped site is never dressed up as one.
  //
  // Attribution order:
  //   1. evidence.source_reel_url — recorded by the backend, exact
  //   2. source_url, if it happens to be Instagram (a user-pasted place can be)
  //   3. legacy rows only: the trip's single Reel, which is unambiguous
  //   4. nothing. A legacy multi-Reel trip gives no honest way to say WHICH one this came from,
  //      and guessing would put a wrong citation under a verbatim quote.
  const tripReels = bundle.inspiration
    .map((i) => i.normalized_reel_url)
    .filter((u): u is string => isInstagram(u))
  const uniqueReels = [...new Set(tripReels)]

  const reelUrl =
    // The backend now records which Reel a place came from, so this is exact rather than a guess.
    (isInstagram(e.source_reel_url ?? null) ? e.source_reel_url! : null)
    // `source_url` is a research/venue page by design and is almost never Instagram, but a
    // user-pasted place can put one there.
    ?? (isInstagram(e.source_url) ? e.source_url! : null)
    // Legacy rows persisted before source_reel_url existed. One Reel on the trip means the
    // attribution is unambiguous; several means it cannot be made honest, so we show none.
    ?? (uniqueReels.length === 1 ? uniqueReels[0] : null)

  const reel = reelUrl ? { url: reelUrl, label: 'Watch the Reel ↗' } : null

  // Kept, but demoted and never mislabelled: it is a reference, not the thing they saved.
  const reference =
    e.source_url && !isInstagram(e.source_url) ? { url: e.source_url, label: 'Reference ↗' } : null

  // The Reel's own thumbnail, matched through the trip's inspiration items.
  const imageUrl =
    (reelUrl
      ? bundle.inspiration.find((i) => i.normalized_reel_url === reelUrl)?.thumbnail_url
      : null) ?? null

  return {
    eyebrow,
    title,
    subtitle: localName && localName !== title ? localName : null,
    where,
    imageUrl,
    context,
    eats,
    evidenceLabel,
    evidence,
    confidence: Number.isFinite(e.confidence) ? Math.round(e.confidence * 100) : null,
    reel,
    reference,
  }
}

/**
 * NOT included, deliberately: opening hours, price, ratings, phone.
 *
 * None of it exists anywhere in the schema — there is no field, no table, and no provider wired
 * for it. Showing a plausible-looking "Open until 18:00" that we inferred would be exactly the
 * hallucinated-place failure guardrail #1 exists to prevent, on the one surface where the product
 * promises every claim is evidence-backed.
 */
