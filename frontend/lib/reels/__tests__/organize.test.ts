import { describe, expect, it } from 'vitest'
import { countryDisplayLabel, groupPlacesByCountry } from '@/lib/reels/organize'
import type { SavedReelPlaceProof } from '@/lib/reels/backend-types'

const place = (overrides: Partial<SavedReelPlaceProof> = {}): SavedReelPlaceProof => ({
  place_id: 'place-tower',
  name: 'Tokyo Tower',
  lat: 35.6586,
  lng: 139.7454,
  country_code: 'JP',
  country_name: 'Japan',
  evidence_quote: 'Tokyo Tower at sunset',
  source_url: 'https://www.instagram.com/reel/AAA/',
  source_reel_url: 'https://www.instagram.com/reel/AAA/',
  confidence: 0.94,
  ...overrides,
})

describe('groupPlacesByCountry', () => {
  it('groups grounded places by country and preserves source proof', () => {
    const groups = groupPlacesByCountry([
      place(),
      place({ place_id: 'place-shrine', name: 'Senso-ji', country_code: 'JP' }),
      place({ place_id: 'place-cafe', name: 'Cafe Seoul', country_code: 'KR', country_name: 'South Korea' }),
    ])

    expect(groups).toEqual([
      {
        country_code: 'JP',
        country_name: 'Japan',
        places: [
          expect.objectContaining({ place_id: 'place-shrine', name: 'Senso-ji' }),
          expect.objectContaining({ place_id: 'place-tower', source_url: 'https://www.instagram.com/reel/AAA/' }),
        ],
      },
      {
        country_code: 'KR',
        country_name: 'South Korea',
        places: [expect.objectContaining({ place_id: 'place-cafe' })],
      },
    ])
  })

  it('deduplicates a canonical place repeated across source Reels', () => {
    expect(groupPlacesByCountry([
      place(),
      place({ source_url: 'https://www.instagram.com/reel/BBB/', evidence_quote: 'tower again' }),
    ])[0].places).toHaveLength(1)
  })

  it('renders backend-verified China, Japan, and Korea trays without renaming them', () => {
    const groups = groupPlacesByCountry([
      place({ place_id: 'jp', name: 'Tokyo place', country_code: 'JP', country_name: 'Japan' }),
      place({ place_id: 'cn', name: 'Shanghai place', country_code: 'CN', country_name: "People's Republic of China" }),
      place({ place_id: 'kr', name: 'Seoul place', country_code: 'KR', country_name: 'South Korea' }),
    ])

    expect(groups.map(({ country_code, country_name }) => ({ country_code, country_name }))).toEqual([
      { country_code: 'JP', country_name: 'Japan' },
      { country_code: 'CN', country_name: "People's Republic of China" },
      { country_code: 'KR', country_name: 'South Korea' },
    ])
  })
})

describe('countryDisplayLabel', () => {
  it('labels the live CN tray China without touching the stored provider name', () => {
    const [tray] = groupPlacesByCountry([
      place({ place_id: 'cn', name: 'The Bund', country_code: 'CN', country_name: "People's Republic of China" }),
    ])

    expect(tray.country_code).toBe('CN')
    expect(countryDisplayLabel(tray)).toBe('China')
    // Asserted after the lookup: the label is presentation-only, never a write back to the tray.
    expect(tray.country_name).toBe("People's Republic of China")
  })

  it('falls through to the stored provider name for countries without an override', () => {
    const [tray] = groupPlacesByCountry([place()])

    expect(countryDisplayLabel(tray)).toBe('Japan')
  })
})
