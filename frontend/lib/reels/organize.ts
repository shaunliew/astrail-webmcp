import type { SavedReelPlaceProof } from './backend-types'

export type CountryTray = {
  country_code: string
  country_name: string
  places: SavedReelPlaceProof[]
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
    .sort((a, b) => a.country_name.localeCompare(b.country_name))
}
