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

/**
 * The Instagram Reel a stop came from, if it can be attributed honestly.
 *
 * Shared by the popup and the map pin so a stop never shows one Reel's photo and another's link.
 * Order: the backend's recorded source_reel_url, then an Instagram source_url, then — for rows
 * written before source_reel_url existed — the trip's single Reel, which is unambiguous. Several
 * Reels and no recorded attribution means we cannot say which, so we say none.
 */
export function reelUrlFor(bundle: TripBundle, tripPlace: TripPlace): string | null {
  const e = tripPlace.evidence_json
  /* Provenance gates EVERY path, not only the legacy fallback. A URL field is not provenance:
     an Instagram link can sit in `source_url` on a stop the user typed, and citing it would
     claim a Reel we did not get the place from (guardrail #1).

     Both discriminators are required because the backend writes them from ONE total mapping
     (persist.py::_evidence_kind), so they agree on every row it wrote — which means demanding
     both costs nothing there, and is exactly what protects against rows it did not write:
     dedup can rewrite source_type to user_requested while the representative's evidence_kind
     and Reel URL survive, and legacy or hand-repaired rows reach the client through an
     unvalidated cast with no runtime schema check. */
  if (tripPlace.source_type !== 'reel_extracted' || !isReelEvidence(e.evidence_kind)) return null

  const unique = [...new Set(
    bundle.inspiration.map((i) => i.normalized_reel_url).filter((u): u is string => isInstagram(u)),
  )]
  return (isInstagram(e.source_reel_url ?? null) ? e.source_reel_url! : null)
    ?? (isInstagram(e.source_url) ? e.source_url! : null)
    // Rows written before source_reel_url existed: the trip's single Reel is unambiguous.
    // Several Reels and no recorded attribution means we cannot say which, so we say none.
    ?? (unique.length === 1 ? unique[0] : null)
}

/**
 * The cover frame of the Reel this place came from.
 *
 * A product decision, made knowingly: `reel_cache.thumbnail_url` is one image per REEL, so a Reel
 * that yielded three stops shows the same frame on all three. That is acceptable HERE and would
 * not be elsewhere, because of how it is framed — the popup labels it "From your Instagram Reel"
 * and the pin carries a reel marker, so the image reads as *the source we found this in*, not as
 * a portrait of the venue. It is real evidence, shown as evidence.
 *
 * What was rejected, and why it is a different thing: a stock photo of "a ramen shop" under a
 * specifically named ramen shop, or a Wikipedia geosearch hit (which resolves "Ichiran Shibuya"
 * to a competitor chain nearby). Those invent a depiction. This one shows the actual Reel.
 *
 * Places with no Reel behind them — typed by the user, or surfaced by Astrail's own research —
 * get a placeholder rather than a borrowed image.
 */
export function thumbnailFor(bundle: TripBundle, tripPlace: TripPlace): string | null {
  const reel = reelUrlFor(bundle, tripPlace)
  if (!reel) return null
  return bundle.inspiration.find((i) => i.normalized_reel_url === reel)?.thumbnail_url ?? null
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
  const youAsked = e.evidence_kind === 'requested_by_you'

  // A place the user asked for stores its own NAME as the quote, so the naive rendering was
  // "Why it is here / Osaka Castle / Confidence 100%" — quoting the title back as though it were
  // evidence. Honest provenance for these is simply: you asked for it.
  const evidenceLabel = youAsked
    ? 'Added by you'
    : e.quote && fromReel
      ? 'From your Instagram Reel'
      : 'Why it is here'

  const evidence = youAsked
    ? 'You asked for this stop, so it has no Reel behind it.'
    : e.quote ?? e.rationale ?? 'No caption quote is available for this stop.'

  // The traveller saved a Reel, not a restaurant's homepage. So the primary link is ALWAYS the
  // Instagram Reel when one can be attributed, and a scraped site is never dressed up as one.
  //
  // Attribution order:
  //   1. evidence.source_reel_url — recorded by the backend, exact
  //   2. source_url, if it happens to be Instagram (a user-pasted place can be)
  //   3. legacy rows only: the trip's single Reel, which is unambiguous
  //   4. nothing. A legacy multi-Reel trip gives no honest way to say WHICH one this came from,
  //      and guessing would put a wrong citation under a verbatim quote.
  const reelUrl = reelUrlFor(bundle, tripPlace)

  const reel = reelUrl ? { url: reelUrl, label: 'Watch the Reel ↗' } : null

  // Kept, but demoted and never mislabelled: it is a reference, not the thing they saved.
  const reference =
    e.source_url && !isInstagram(e.source_url) ? { url: e.source_url, label: 'Reference ↗' } : null

  // The Reel's own thumbnail, matched through the trip's inspiration items.
  const imageUrl = thumbnailFor(bundle, tripPlace)

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
    // Confidence is a measure of how well a Reel caption was matched. For a place the user typed
    // in, "100%" says nothing and reads like a claim we cannot back.
    confidence: youAsked || !Number.isFinite(e.confidence) ? null : Math.round(e.confidence * 100),
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
