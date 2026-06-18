import { tokyoTripDemo } from "@/lib/trip/demo-data";
import { normalizeTripFromBackend } from "@/lib/trip/normalize-trip";
import type { TripExperience } from "@/lib/trip/types";

export type TripLoadResult = {
  trip: TripExperience;
  source: "demo" | "backend";
  notice?: string;
};

export async function getTripExperience(): Promise<TripLoadResult> {
  const endpoint = process.env.NEXT_PUBLIC_TRIP_ENDPOINT?.trim();

  if (!endpoint) {
    return {
      trip: tokyoTripDemo,
      source: "demo",
    };
  }

  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Trip endpoint returned ${response.status}.`);
    }

    const rawTrip = await response.json();
    const trip = normalizeTripFromBackend(rawTrip);

    return {
      trip,
      source: "backend",
    };
  } catch {
    return {
      trip: tokyoTripDemo,
      source: "demo",
      notice: "Demo data",
    };
  }
}
