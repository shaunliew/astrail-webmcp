export type BudgetLevel = "budget" | "mid_range" | "luxury";

export type BackendExtractedPlace = {
  name: string;
  category: string;
  city_or_region_guess: string;
  lat?: number | null;
  lng?: number | null;
  formatted_address?: string | null;
  confidence: number;
  evidence_caption_quote: string;
  source_url?: string | null;
  place_id?: string | null;
};

export type ExtractResponse = {
  places: BackendExtractedPlace[];
  source: "live" | "cache" | string;
  count: number;
};

export type UserPreferencesPayload = {
  start_date: string;
  end_date: string;
  budget_level: BudgetLevel;
  free_text: string;
  origin_city?: string | null;
};

export type ItineraryRequestPayload = {
  places: BackendExtractedPlace[];
  preferences: UserPreferencesPayload;
};

export type ItineraryStreamEvent =
  | {
      type: "start";
      n_places_in?: number;
      n_places_used?: number;
      destination?: string;
    }
  | {
      type: "heartbeat";
      elapsed_s?: number;
    }
  | {
      type: "stage";
      stage: "weather" | "booking" | "narrator" | string;
      msg?: string;
    }
  | {
      type: "result";
      content: string;
      elapsed_s?: number;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

// Weather (from spike_weather.py)
export type DayForecast = {
  date: string;
  temp_min_c: number;
  temp_max_c: number;
  precipitation_mm: number;
  summary: string;
};

export type WeatherReport = {
  destination: string;
  day_forecasts: DayForecast[];
};

// Booking (from spike_booking.py) — every item is_mock=true; status="confirmed" only for Duffel sandbox.
export type BookingItem = {
  booking_id: string;
  category: "flight" | "hotel" | "attraction";
  name: string;
  price_estimate_sgd: number | null;
  status: "confirmed" | "reserved";
  book_url: string;
  source: "duffel_sandbox" | "booking_deeplink" | "klook_deeplink";
  is_mock: boolean;
  notes: string;
};

export type BookingResult = {
  items: BookingItem[];
  total_estimate_sgd: number;
  is_mock: boolean;
};

export type BackendTripPayload = unknown;
