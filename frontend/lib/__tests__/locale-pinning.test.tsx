/* Every date this app prints must read the same on the server and in the visitor's browser.
 *
 * `toLocaleDateString(undefined, …)` means "use the runtime's default locale". Node renders the
 * SSR pass in en-US; the browser uses whatever the visitor set. On /app/trip/demo that produced
 * "Sep 18" from the server and "18 Sept" in an en-GB browser, and React threw away the tree:
 *
 *   Hydration failed because the server rendered text didn't match the client.
 *   + 18 Sept   - Sep 18
 *
 * A test that asserts "Sep 18" under the default runtime is worthless here — CI's default IS
 * en-US, so it passes with the bug fully present. `coerceDefaultLocale` stands in for the
 * visitor's browser by making every *unpinned* call resolve against en-GB, so only a call that
 * names its locale can still produce US output. That is the property under test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import DaySelector from '@/components/trip/DaySelector'
import { tripDateRange } from '@/lib/trip/trip-presenters'
import { buildStayPopup } from '@/components/map/suggestion-popup'
import { statusLabel } from '@/lib/reels/labels'
import type { HotelSuggestion, Trip, TripDay } from '@/lib/trip/backend-types'
import type { SavedReelCard } from '@/lib/reels/backend-types'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

/** Make unpinned `toLocale*` calls resolve against `locale`, exactly as a non-US browser would.
 *  Calls that pass a locale explicitly are untouched — that asymmetry is what the tests read. */
function coerceDefaultLocale(locale: string) {
  const realDate = Date.prototype.toLocaleDateString
  const realBoth = Date.prototype.toLocaleString
  beforeEach(() => {
    Date.prototype.toLocaleDateString = function (l?: unknown, o?: unknown) {
      return realDate.call(this, (l ?? locale) as string, o as Intl.DateTimeFormatOptions)
    }
    Date.prototype.toLocaleString = function (l?: unknown, o?: unknown) {
      return realBoth.call(this, (l ?? locale) as string, o as Intl.DateTimeFormatOptions)
    }
  })
  afterEach(() => {
    Date.prototype.toLocaleDateString = realDate
    Date.prototype.toLocaleString = realBoth
  })
}

/** The same coercion for numbers. A different locale on purpose: en-GB groups thousands exactly
 *  as en-US does, so it could not tell a pinned call from an unpinned one. de-DE can. */
function coerceDefaultNumberLocale(locale: string) {
  const real = Number.prototype.toLocaleString
  beforeEach(() => {
    Number.prototype.toLocaleString = function (l?: unknown, o?: unknown) {
      return real.call(this, (l ?? locale) as string, o as Intl.NumberFormatOptions)
    }
  })
  afterEach(() => {
    Number.prototype.toLocaleString = real
  })
}

/* Two of the four sites format a real instant rather than a date-only string, so their calendar
   day depends on the machine's zone. Pin it for this file only, and put it back after. */
const realTZ = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'UTC'
})
afterAll(() => {
  process.env.TZ = realTZ
})

coerceDefaultLocale('en-GB')
coerceDefaultNumberLocale('de-DE')

const day = (over: Partial<TripDay> = {}): TripDay => ({
  id: 'd1', trip_id: 't1', day_number: 1, day_date: '2026-09-18', title: null, summary: null,
  weather_summary: null, weather_source: null, weather_payload: {}, ...over,
})

const trip = (over: Partial<Trip> = {}): Trip => ({ ...TOKYO_TRIP.trip, ...over })

const hotel = (over: Partial<HotelSuggestion> = {}): HotelSuggestion => ({
  id: 'h1', trip_id: 't1', trip_day_id: null, base_place_id: null,
  name: 'Mitsui Garden Hotel', area: 'Ginza', star_rating: 4,
  price_snapshot: { currency: 'USD', pricePerNight: 261.49, totalPrice: 522.98 },
  travala_hotel_id: 'tv1', preference_match_json: {}, guest_rating: 9.6, refundable: true,
  free_cancellation_until: '2026-09-16T14:59:00Z', source: 'travala', status: 'suggested',
  searched_at: '2026-08-01T00:00:00Z', lat: 35.6, lng: 139.7, geo_status: 'placed',
  route_score: 400, rank: 1, is_recommended: true, place_durations: {}, ...over,
})

const card = (over: Partial<SavedReelCard> = {}): SavedReelCard => ({
  id: 'r1', user_id: 'u1', normalized_url: 'https://www.instagram.com/reel/r1',
  source_platform: 'instagram', reel_cache_id: null, has_current_cache: false,
  analysis_status: 'not_analyzed', personal_label: null, retry_after: null, analyzed_at: null,
  created_at: '2026-08-27T00:00:00Z', updated_at: '2026-08-27T00:00:00Z',
  caption: null, thumbnail_url: null, places: [], ...over,
})

describe('the harness itself', () => {
  // Without this, a green suite below would be indistinguishable from a coercion that silently
  // stopped working — every assertion would pass for the wrong reason.
  it('really does move the default locale, and en-GB really does differ', () => {
    const d = new Date('2026-09-18T00:00:00')
    expect(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })).toBe('18 Sept')
    expect(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })).toBe('Sep 18')
  })

  it('really does move the default number locale, and de-DE really does differ', () => {
    expect((1234).toLocaleString()).toBe('1.234')
    expect((1234).toLocaleString('en-US')).toBe('1,234')
  })
})

describe('date output is locale-independent', () => {
  it('DaySelector prints the SSR spelling in a non-US browser', () => {
    // The exact reported failure: server "Sep 18" vs client "18 Sept" on /app/trip/demo.
    render(<DaySelector days={[day()]} activeDayNumber={1} onSelect={() => {}} />)
    expect(screen.getByRole('tab', { name: /day 1/i })).toHaveTextContent('Sep 18')
  })

  it('tripDateRange prints the SSR spelling in a non-US browser', () => {
    expect(tripDateRange(trip({ start_date: '2026-09-18', end_date: '2026-09-20' })))
      .toBe('Sep 18 – Sep 20')
    expect(tripDateRange(trip({ start_date: '2026-09-18', end_date: null }))).toBe('Sep 18')
  })

  it('the stay popup prints a cancellation deadline in the SSR spelling', () => {
    const text = buildStayPopup(hotel(), Date.parse('2026-08-27T00:00:00Z')).textContent!
    expect(text).toContain('Free cancellation until Sep 16, 2026')
  })

  it('the stay popup groups a price the same way everywhere', () => {
    // "USD 1.234" in a de-DE runtime reads as one dollar twenty-three — a four-figure error in
    // the one number on the popup a traveller acts on.
    const pricey = hotel({ price_snapshot: { currency: 'USD', pricePerNight: 1234 } })
    const text = buildStayPopup(pricey, Date.parse('2026-08-27T00:00:00Z')).textContent!
    expect(text).toContain('USD 1,234 / night')
  })

  it('the daily-limit label prints its reset date in the SSR spelling', () => {
    const limited = card({ analysis_status: 'failed', retry_after: '2026-09-18T12:00:00Z' })
    expect(statusLabel(limited, Date.parse('2026-09-17T00:00:00Z')))
      .toBe('Daily limit reached · try again Sep 18')
  })
})

describe('a date-only string names the same calendar day everywhere', () => {
  /* Why the fix is a locale and NOT `timeZone: 'UTC'`, unlike lib/webmcp/format.ts.
     `new Date('2026-09-18T00:00:00')` (no Z) is LOCAL midnight, and formatting it with no
     `timeZone` reads it back in that same local zone — so the calendar day survives every
     offset, and pinning UTC would actively break it (local midnight in UTC+8 is 16:00 the
     PREVIOUS day in UTC). The reported error was two spellings of one day, not two days. */
  it('renders 18 September as the 18th from UTC-11 through UTC+14', () => {
    const zones = ['Pacific/Midway', 'America/Los_Angeles', 'UTC', 'Asia/Singapore', 'Pacific/Kiritimati']
    for (const zone of zones) {
      process.env.TZ = zone
      const { unmount } = render(<DaySelector days={[day()]} activeDayNumber={1} onSelect={() => {}} />)
      expect(screen.getByRole('tab', { name: /day 1/i }), zone).toHaveTextContent('Sep 18')
      unmount()
    }
    process.env.TZ = 'UTC'
  })
})
