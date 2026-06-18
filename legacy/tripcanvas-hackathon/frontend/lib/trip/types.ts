export const PLACE_CATEGORIES = [
  "landmark",
  "crossing",
  "temple",
  "shrine",
  "market",
  "restaurant",
  "hotel",
  "attraction",
  "transport",
  "activity",
  "station",
  "other",
] as const;

export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];
export type TripDayNumber = number;
export type DayFilter = "all" | TripDayNumber;
export type CategoryFilter = "all" | PlaceCategory;

export type TripDestination = {
  city: string;
  country: string;
  center: [lng: number, lat: number];
  zoom: number;
};

export type TripSourceReel = {
  id: string;
  url: string;
  thumbnailUrl?: string;
  extractedPlaceIds: string[];
};

export type TripRoute = {
  coordinates: [lng: number, lat: number][];
  durationMinutes?: number;
  distanceKm?: number;
};

export type TripPlace = {
  id: string;
  name: string;
  category: PlaceCategory;
  day: TripDayNumber;
  lat: number;
  lng: number;
  summary: string;
  address?: string;
  evidenceQuote?: string;
  plannerSummary?: string;
  dayPlanText?: string;
  sourceUrl?: string;
  sourceReelUrl?: string;
  confidence?: number;
};

export type TripDay = {
  day: TripDayNumber;
  title: string;
  summary: string;
  placeIds: string[];
  route?: TripRoute;
};

export type TripExperience = {
  id: string;
  title: string;
  destination: TripDestination;
  datesLabel: string;
  days: TripDay[];
  places: TripPlace[];
  sourceReels?: TripSourceReel[];
};
