import type {
  TripBundle, TripPlace, TripDay, TransportLeg,
  RestaurantSuggestion, HotelSuggestion, Place,
} from './backend-types'

const bySortOrder = (a: TripPlace, b: TripPlace) =>
  (a.sort_order ?? Number.POSITIVE_INFINITY) - (b.sort_order ?? Number.POSITIVE_INFINITY)

export function orderedDays(bundle: TripBundle): TripDay[] {
  return [...bundle.days].sort((a, b) => a.day_number - b.day_number)
}

export function placesForDay(bundle: TripBundle, dayNumber: number): TripPlace[] {
  return bundle.places.filter((tp) => tp.day_number === dayNumber).sort(bySortOrder)
}

export function legsForDay(bundle: TripBundle, dayId: string): TransportLeg[] {
  return bundle.transport_legs
    .filter((l) => l.trip_day_id === dayId)
    .sort((a, b) => a.leg_order - b.leg_order)
}

export function restaurantsForDay(bundle: TripBundle, dayId: string): RestaurantSuggestion[] {
  return bundle.restaurants.filter((r) => r.trip_day_id === dayId)
}

export function tripHotels(bundle: TripBundle): HotelSuggestion[] {
  return bundle.hotels
}

export function buildPlaceIndex(bundle: TripBundle): Map<string, Place> {
  return new Map(bundle.places.map((tp) => [tp.place_id, tp.place]))
}

export function findTripPlace(bundle: TripBundle, placeId: string | null): TripPlace | null {
  if (!placeId) return null
  return bundle.places.find((tp) => tp.place_id === placeId) ?? null
}

export function pinLabelForPlace(
  bundle: TripBundle,
  tripPlace: TripPlace,
  activeDayNumber: number,
): string | null {
  if (tripPlace.day_number !== activeDayNumber) return null
  const index = placesForDay(bundle, activeDayNumber).findIndex((tp) => tp.id === tripPlace.id)
  return index >= 0 ? String(index + 1) : null
}
