import type {
  BackendExtractedPlace,
  BudgetLevel,
  ExtractResponse,
  ItineraryRequestPayload,
  ItineraryStreamEvent,
  UserPreferencesPayload,
} from "@/lib/trip/backend-types";
import { normalizePlaceCategory, normalizeTripFromBackend } from "@/lib/trip/normalize-trip";
import { parseSseStream } from "@/lib/trip/sse";
import type { TripExperience, TripPlace } from "@/lib/trip/types";

export type GenerationFormValues = {
  reelUrls: string[];
  startDate: string;
  endDate: string;
  budgetLevel: BudgetLevel;
  originCity: string;
  preferences: string;
};

export type StreamItineraryOptions = {
  signal?: AbortSignal;
  onEvent?: (event: ItineraryStreamEvent) => void;
};

export async function extractReelPlaces(
  reelUrls: string[],
  signal?: AbortSignal,
): Promise<ExtractResponse> {
  const response = await fetch(`${getBackendBaseUrl()}/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ reel_urls: reelUrls }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Extraction failed with HTTP ${response.status}.`);
  }

  return response.json() as Promise<ExtractResponse>;
}

export async function streamItinerary(
  payload: ItineraryRequestPayload,
  options: StreamItineraryOptions = {},
): Promise<unknown> {
  const response = await fetch(`${getBackendBaseUrl()}/itinerary`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Itinerary failed with HTTP ${response.status}.`);
  }

  if (!response.body) {
    throw new Error("Itinerary stream did not include a response body.");
  }

  let finalPayload: unknown = null;

  for await (const message of parseSseStream(response.body)) {
    if (message.data === "[DONE]") {
      break;
    }

    const event = JSON.parse(message.data) as ItineraryStreamEvent;
    options.onEvent?.(event);

    if (event.type === "error") {
      throw new Error(typeof event.message === "string" ? event.message : "Planner failed.");
    }

    if (event.type === "result" && typeof event.content === "string") {
      finalPayload = JSON.parse(event.content);
    }
  }

  if (!finalPayload) {
    throw new Error("Itinerary stream ended without a result event.");
  }

  return finalPayload;
}

export function buildPreferencesPayload(values: GenerationFormValues): UserPreferencesPayload {
  return {
    start_date: values.startDate,
    end_date: values.endDate,
    budget_level: values.budgetLevel,
    free_text: values.preferences.trim(),
    origin_city: values.originCity.trim() || null,
  };
}

export function buildProvisionalTrip(
  places: BackendExtractedPlace[],
  preferences: UserPreferencesPayload,
): TripExperience {
  const tripPlaces = places
    .map(toTripPlace)
    .filter((place): place is TripPlace => Boolean(place));
  const destination = buildDestination(places, tripPlaces);
  const placeIds = tripPlaces.map((place) => place.id);

  return {
    id: `generated-${Date.now()}`,
    title: `${destination.city} Reel Trip`,
    datesLabel: formatDatesLabel(preferences.start_date, preferences.end_date),
    destination,
    days: [
      {
        day: 1,
        title: "Detected places",
        summary: "Places extracted from the submitted Reels while the itinerary agent plans the trip.",
        placeIds,
      },
    ],
    places: tripPlaces,
  };
}

export function buildFinalTrip(
  extractedPlaces: BackendExtractedPlace[],
  itinerary: unknown,
  preferences: UserPreferencesPayload,
): TripExperience {
  const tripPlaces = extractedPlaces
    .map(toTripPlace)
    .filter((place): place is TripPlace => Boolean(place));

  return normalizeTripFromBackend({
    id: `generated-${Date.now()}`,
    datesLabel: formatDatesLabel(preferences.start_date, preferences.end_date),
    destination: buildDestination(extractedPlaces, tripPlaces),
    places: extractedPlaces,
    itinerary,
  });
}

function getBackendBaseUrl() {
  return (process.env.NEXT_PUBLIC_BACKEND_URL?.trim() || "http://localhost:8000").replace(
    /\/+$/,
    "",
  );
}

function toTripPlace(place: BackendExtractedPlace, index: number): TripPlace | null {
  if (!place.name || !hasValidCoordinates(place)) {
    return null;
  }

  return {
    id: place.place_id?.trim() || slugify(place.name) || `place-${index + 1}`,
    name: place.name,
    category: normalizePlaceCategory(place.category),
    day: 1,
    lat: place.lat,
    lng: place.lng,
    summary:
      place.evidence_caption_quote ||
      place.formatted_address ||
      "Extracted from your submitted Reels.",
    ...(place.formatted_address ? { address: place.formatted_address } : {}),
    ...(place.evidence_caption_quote ? { evidenceQuote: place.evidence_caption_quote } : {}),
    ...(place.source_url ? { sourceUrl: place.source_url } : {}),
    confidence: place.confidence,
  };
}

function buildDestination(
  extractedPlaces: BackendExtractedPlace[],
  tripPlaces: TripPlace[],
): TripExperience["destination"] {
  const center = getPlacesCenter(tripPlaces) ?? [139.7671, 35.6812];
  const city =
    extractedPlaces.find((place) => place.city_or_region_guess)?.city_or_region_guess ||
    "Destination";
  const country = inferCountry(extractedPlaces);

  return {
    city,
    country,
    center,
    zoom: tripPlaces.length > 1 ? 11.2 : 13.2,
  };
}

function getPlacesCenter(places: TripPlace[]): [number, number] | null {
  if (places.length === 0) {
    return null;
  }

  const totals = places.reduce(
    (acc, place) => ({
      lng: acc.lng + place.lng,
      lat: acc.lat + place.lat,
    }),
    { lng: 0, lat: 0 },
  );

  return [totals.lng / places.length, totals.lat / places.length];
}

function hasValidCoordinates(
  place: BackendExtractedPlace,
): place is BackendExtractedPlace & { lat: number; lng: number } {
  return (
    typeof place.lat === "number" &&
    typeof place.lng === "number" &&
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lng) &&
    place.lat >= -90 &&
    place.lat <= 90 &&
    place.lng >= -180 &&
    place.lng <= 180
  );
}

function inferCountry(places: BackendExtractedPlace[]) {
  const address = places.find((place) => place.formatted_address)?.formatted_address;
  if (!address) {
    return "";
  }

  return address.split(",").at(-1)?.trim() ?? "";
}

function formatDatesLabel(startDate: string, endDate: string) {
  if (!startDate || !endDate) {
    return "Trip dates";
  }

  if (startDate === endDate) {
    return startDate;
  }

  return `${startDate} to ${endDate}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
