import type { HotelSuggestion, Place, RestaurantSuggestion } from '@/lib/trip/backend-types'

/**
 * Popups for the two SUGGESTION layers — "Where to eat" and "Where to stay".
 *
 * Separate from `popup-model.ts`, which answers "why is this stop on MY trip". A suggestion is not
 * a stop: it has no day position, no arrival leg and no Reel behind it, so the trip-relative
 * framing there would be mostly empty fields. What a traveller wants here is narrower — what kind
 * of place is it, why did Astrail pick it, and what will it cost.
 *
 * NOT SHOWN, and not an oversight: opening hours, photos, phone numbers, review counts. None of it
 * exists in the schema — no column, no table, no provider — and Travala returns no image either.
 * A plausible "Open until 18:00" that we inferred is precisely the hallucinated-detail failure
 * guardrail #1 exists to prevent, on a product whose promise is that every claim is backed.
 *
 * NEITHER card shows "matches your taste", though `preference_match_json` exists on both types.
 * `persist_restaurants` and `persist_hotels` insert `{}` literally — "stays {} until prefs are
 * wired (Step 9)" — and a live check of both tables found `{}` on every row. It rendered for the
 * fixture and never once in production. A section that is always empty on real data is worse than
 * no section, and a field that exists is not evidence that anything fills it.
 *
 * Every value is written with textContent. Restaurant summaries are model-written and hotel names
 * come from a third-party API; neither is ever parsed as markup.
 */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** `price_snapshot` is `Record<string, unknown>` — a jsonb column, so every read is a guess until
 *  checked. A malformed snapshot yields no price line rather than "USD undefined". */
function num(source: Record<string, unknown>, key: string): number | null {
  const v = source[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function money(currency: string | null, amount: number | null): string | null {
  if (amount === null) return null
  // Whole units: a nightly rate to the cent is noise at a glance, and the exact figure is the
  // booking site's to state at the moment of booking, not ours to freeze in a map popup.
  const rounded = Math.round(amount)
  // Grouping is locale-dependent too — a de-DE runtime writes "1.234", which next to a USD
  // symbol reads as one dollar twenty-three. Pinned for the same reason the dates above are.
  return currency ? `${currency} ${rounded.toLocaleString('en-US')}` : String(rounded)
}

function appendLink(content: HTMLElement, url: string | null, label: string): void {
  if (!url) return
  let safe: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    safe = parsed.href
  } catch {
    return
  }
  const a = document.createElement('a')
  a.className = 'evidence-popup__source evidence-popup__source--secondary'
  a.href = safe
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.textContent = label
  content.append(a)
}

/** "Where to eat": what kind of food, where exactly, why Astrail chose it, and which stop it sits
 *  beside.
 *
 *  NO "matches your taste" row, though the field exists: `persist_restaurants` inserts
 *  `preference_match_json: {}` literally — "stays {} until prefs are wired (Step 9)" — so that
 *  block rendered for the fixture and never once in production. A section that is always empty on
 *  real data is worse than no section.
 *
 *  The street address IS real and was already being stored, unused, in `evidence_json.address`
 *  (Mapbox's `full_address`). On a map, where-exactly answers more than a website would.
 *
 *  `distance_m` is deliberately NOT rendered next to the anchor stop's name. It is measured from
 *  the DAY'S CENTROID — the point `suggest_restaurants` searched around — not from `near_place_id`.
 *  Printing "180 m from Nukata Station" would be a precise-sounding falsehood. */
export function buildEatPopup(r: RestaurantSuggestion, place: Place, nearName?: string | null): HTMLElement {
  const content = el('article', 'evidence-popup suggestion-popup')
  content.append(el('p', 'evidence-popup__eyebrow', ['Where to eat', r.cuisine].filter(Boolean).join(' · ')))
  content.append(el('h3', 'evidence-popup__title', place.name))

  const address = typeof r.evidence_json.address === 'string' ? r.evidence_json.address : null
  const where = address || [place.area, place.city].filter(Boolean).join(', ')
  if (where) content.append(el('p', 'evidence-popup__where', where))

  if (r.summary) content.append(el('p', 'suggestion-popup__body', r.summary))
  if (nearName) content.append(el('p', 'suggestion-popup__matches', `Near ${nearName}`))

  const details = eatDetails(r)
  if (details.hours) content.append(el('p', 'suggestion-popup__body', details.hours))
  appendLink(content, details.website ?? r.source_url, 'More about this place ↗')
  return content
}

/** Opening hours + website written by the details enrichment (see backend
 *  genagents/restaurant_details.py). Absent on every row generated before it existed, and absent
 *  whenever the search found nothing it could attribute — so both reads are guarded and neither
 *  is ever synthesised. */
function eatDetails(r: RestaurantSuggestion): { hours: string | null, website: string | null } {
  const d = r.evidence_json.details
  if (!d || typeof d !== 'object') return { hours: null, website: null }
  const rec = d as Record<string, unknown>
  return {
    hours: typeof rec.opening_hours === 'string' && rec.opening_hours.trim() ? rec.opening_hours : null,
    website: typeof rec.website === 'string' ? rec.website : null,
  }
}

/** "Where to stay": the numbers that actually decide a hotel — class, guest score, nightly rate,
 *  trip total, and how cancellable it was.
 *
 *  `now` is injectable because the cancellation deadline is a SNAPSHOT taken at `searched_at`, not
 *  a live quote: a trip reopened weeks later can hold a deadline that has already passed, and
 *  printing "Free cancellation until 16 July" in August states something untrue. Past deadlines
 *  degrade to a plainly-worded past-tense line instead. */
export function buildStayPopup(h: HotelSuggestion, now: number = Date.now()): HTMLElement {
  const content = el('article', 'evidence-popup suggestion-popup')
  const eyebrow = ['Where to stay', h.is_recommended ? 'Recommended' : null].filter(Boolean).join(' · ')
  content.append(el('p', 'evidence-popup__eyebrow', eyebrow))
  content.append(el('h3', 'evidence-popup__title', h.name))

  if (h.area) content.append(el('p', 'evidence-popup__where', h.area))

  if (h.star_rating !== null) {
    // Rounded to whole stars: a hotel class is 1–5, and "4.0" reads like a review score.
    content.append(el('p', 'suggestion-popup__stars', `${'★'.repeat(Math.round(h.star_rating))} ${h.star_rating} star`))
  }

  // Travala's guest score is 0–10 and is a DIFFERENT measure from the star class. Labelled so the
  // two never read as one number — "4 star · 9.4" alone invites reading 9.4 as nine stars.
  if (h.guest_rating !== null) {
    content.append(el('p', 'suggestion-popup__body', `${h.guest_rating}/10 guest score`))
  }

  const currency = typeof h.price_snapshot.currency === 'string' ? h.price_snapshot.currency : null
  const nightly = money(currency, num(h.price_snapshot, 'pricePerNight'))
  const total = money(currency, num(h.price_snapshot, 'totalPrice'))
  const price = [nightly && `${nightly} / night`, total && `${total} total`].filter(Boolean).join(' · ')
  if (price) content.append(el('p', 'suggestion-popup__body', price))

  const cancellation = cancellationLine(h, now)
  if (cancellation) content.append(el('p', 'suggestion-popup__body', cancellation))

  // Search results, not an offer. Prices move and availability lapses, so the popup says where
  // the number came from rather than implying we are holding it.
  content.append(el('p', 'suggestion-popup__note', 'Search result from Travala — prices change; Astrail does not book.'))
  return content
}

/** A live deadline is worth stating precisely; an expired one is only worth stating in the past
 *  tense. Neither is worth inventing, so an unknown refundability produces no line at all. */
function cancellationLine(h: HotelSuggestion, now: number): string | null {
  const until = h.free_cancellation_until ? Date.parse(h.free_cancellation_until) : NaN
  if (Number.isFinite(until) && until > now) {
    // Locale pinned like every other date in the app (one spelling of "Sep", not two). The zone
    // stays local on purpose: this is a real instant, not a date-only string, so the deadline is
    // most useful stated in the reader's own day. This path is browser-only — TripMap is
    // `dynamic(..., { ssr: false })` — so it cannot cause a hydration mismatch; it is pinned so
    // there is one rule here, not two.
    const when = new Date(until).toLocaleDateString('en-US', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
    return `Free cancellation until ${when}`
  }
  if (h.refundable === true) return 'Was refundable when we searched — check current terms'
  if (h.refundable === false) return 'Non-refundable when we searched'
  return null
}
