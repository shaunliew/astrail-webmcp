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
  return currency ? `${currency} ${rounded.toLocaleString()}` : String(rounded)
}

/** Preference matches, when the agent recorded which ones this suggestion satisfies. */
function matchedPreferences(source: Record<string, unknown>): string[] {
  const raw = source.matched
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

function appendMatches(content: HTMLElement, matches: string[]): void {
  if (matches.length === 0) return
  content.append(el('p', 'evidence-popup__eyebrow', 'Matches your taste'))
  const list = el('p', 'suggestion-popup__matches', matches.join(' · '))
  content.append(list)
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

/** "Where to eat": what kind of food, why Astrail chose it, and a link when one was recorded.
 *  `source_url` is null on most rows in practice, so the link is the exception, not the rule. */
export function buildEatPopup(r: RestaurantSuggestion, place: Place): HTMLElement {
  const content = el('article', 'evidence-popup suggestion-popup')
  content.append(el('p', 'evidence-popup__eyebrow', ['Where to eat', r.cuisine].filter(Boolean).join(' · ')))
  content.append(el('h3', 'evidence-popup__title', place.name))

  const where = [place.area, place.city].filter(Boolean).join(', ')
  if (where) content.append(el('p', 'evidence-popup__where', where))

  if (r.summary) content.append(el('p', 'suggestion-popup__body', r.summary))
  appendMatches(content, matchedPreferences(r.preference_match_json))
  appendLink(content, r.source_url, 'More about this place ↗')
  return content
}

/** "Where to stay": the numbers that actually decide a hotel — class, nightly rate, trip total.
 *  Travala's guest score and cancellation policy live in `travala_result_json`, which the frontend
 *  type deliberately does not carry, so they are absent here rather than guessed at. */
export function buildStayPopup(h: HotelSuggestion): HTMLElement {
  const content = el('article', 'evidence-popup suggestion-popup')
  const eyebrow = ['Where to stay', h.is_recommended ? 'Recommended' : null].filter(Boolean).join(' · ')
  content.append(el('p', 'evidence-popup__eyebrow', eyebrow))
  content.append(el('h3', 'evidence-popup__title', h.name))

  if (h.area) content.append(el('p', 'evidence-popup__where', h.area))

  if (h.star_rating !== null) {
    // Rounded to whole stars: a hotel class is 1–5, and "4.0" reads like a review score.
    content.append(el('p', 'suggestion-popup__stars', `${'★'.repeat(Math.round(h.star_rating))} ${h.star_rating} star`))
  }

  const currency = typeof h.price_snapshot.currency === 'string' ? h.price_snapshot.currency : null
  const nightly = money(currency, num(h.price_snapshot, 'pricePerNight'))
  const total = money(currency, num(h.price_snapshot, 'totalPrice'))
  const price = [nightly && `${nightly} / night`, total && `${total} total`].filter(Boolean).join(' · ')
  if (price) content.append(el('p', 'suggestion-popup__body', price))

  appendMatches(content, matchedPreferences(h.preference_match_json))

  // Search results, not an offer. Prices move and availability lapses, so the popup says where
  // the number came from rather than implying we are holding it.
  content.append(el('p', 'suggestion-popup__note', 'Search result from Travala — prices change; Astrail does not book.'))
  return content
}
