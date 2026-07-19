import type { SavedReelPlaceProof } from './backend-types'

export type CountryTray = {
  country_code: string
  country_name: string
  places: SavedReelPlaceProof[]
}

// Product-owned display overrides; stored provider names are never mutated (ISSUES-B7).
const COUNTRY_DISPLAY_OVERRIDES: Record<string, string> = { CN: 'China' }

export function countryDisplayLabel(
  tray: Pick<CountryTray, 'country_code' | 'country_name'>,
): string {
  return COUNTRY_DISPLAY_OVERRIDES[tray.country_code] ?? tray.country_name
}

export function groupPlacesByCountry(places: SavedReelPlaceProof[]): CountryTray[] {
  const countries = new Map<string, CountryTray>()
  const seen = new Set<string>()

  for (const place of places) {
    if (seen.has(place.place_id)) continue
    seen.add(place.place_id)
    const key = place.country_code || place.country_name
    const group = countries.get(key) ?? {
      country_code: place.country_code,
      country_name: place.country_name,
      places: [],
    }
    group.places.push(place)
    countries.set(key, group)
  }

  return [...countries.values()]
    .map((group) => ({ ...group, places: [...group.places].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => countryDisplayLabel(a).localeCompare(countryDisplayLabel(b)))
}
