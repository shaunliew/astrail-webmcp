import type { TripDay, TripPlace } from "@/lib/trip/types";

export type PlaceIntel = {
  whyThisStop: string;
  bestTime: string;
  suggestedDuration: string;
  howToGo: string;
  insideOrNearby: string[];
  sourceLabel: string;
  directionsUrl: string;
  visual: {
    label: string;
    detail: string;
  };
};

export function buildPlaceIntel(place: TripPlace, days: TripDay[]): PlaceIntel {
  const day = days.find((candidate) => candidate.day === place.day) ?? null;
  const dayPlanText = place.dayPlanText || day?.summary || "";
  const sourceLabel = getSourceLabel(place.sourceUrl);

  return {
    whyThisStop: buildWhyThisStop(place, dayPlanText),
    bestTime: inferBestTime(place, dayPlanText),
    suggestedDuration: inferSuggestedDuration(place),
    howToGo: buildHowToGo(place),
    insideOrNearby: buildInsideOrNearby(place),
    sourceLabel,
    directionsUrl: buildDirectionsUrl(place),
    visual: {
      label: place.sourceReelUrl ? "Reel-linked place" : "Map-grounded place",
      detail: place.address || `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`,
    },
  };
}

function buildWhyThisStop(place: TripPlace, dayPlanText: string) {
  if (place.plannerSummary) {
    return place.plannerSummary;
  }

  if (dayPlanText) {
    return dayPlanText;
  }

  if (place.evidenceQuote) {
    return `The agent extracted this from your Reel evidence: "${place.evidenceQuote}".`;
  }

  return "The planner placed this stop on the map, but did not return a detailed rationale.";
}

function inferBestTime(place: TripPlace, dayPlanText: string) {
  const lower = dayPlanText.toLowerCase();
  const placeIndex = lower.indexOf(place.name.toLowerCase());
  const context =
    placeIndex >= 0
      ? lower.slice(Math.max(0, placeIndex - 180), Math.min(lower.length, placeIndex + 180))
      : lower;

  if (context.includes("morning")) {
    return `Morning on Day ${place.day}`;
  }

  if (context.includes("afternoon")) {
    return `Afternoon on Day ${place.day}`;
  }

  if (context.includes("evening") || context.includes("night")) {
    return `Evening on Day ${place.day}`;
  }

  return `Suggested for Day ${place.day}`;
}

function inferSuggestedDuration(place: TripPlace) {
  const text = `${place.plannerSummary ?? ""} ${place.dayPlanText ?? ""}`.toLowerCase();
  const durationMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:-|to)?\s*(\d+(?:\.\d+)?)?\s*(hour|hours|hr|hrs|minute|minutes|min|mins)/);

  if (durationMatch) {
    return durationMatch[0];
  }

  return "No duration estimate found from the planner source.";
}

function buildHowToGo(place: TripPlace) {
  const stationSentence = findSentence(
    `${place.plannerSummary ?? ""} ${place.dayPlanText ?? ""}`,
    ["station", "metro", "train", "walk", "transfer", "nearest"],
  );

  if (stationSentence) {
    return stationSentence;
  }

  if (place.address) {
    return place.address;
  }

  return "No transit detail found from the planner source.";
}

function buildInsideOrNearby(place: TripPlace) {
  const text = `${place.plannerSummary ?? ""} ${place.dayPlanText ?? ""}`;
  const keywords = [
    "shop",
    "restaurant",
    "cafe",
    "tower",
    "street",
    "park",
    "spa",
    "rooftop",
    "dining",
    "exhibition",
    "photo",
    "entrance",
    "halls",
    "theater",
    "temple",
    "sign",
    "food",
  ];
  const sentences = splitSentences(text)
    .filter((sentence) => containsAny(sentence, keywords))
    .slice(0, 4);

  if (sentences.length > 0) {
    return sentences;
  }

  return ["No specific shops, sights, or nearby highlights found from the planner source."];
}

function findSentence(text: string, keywords: string[]) {
  return splitSentences(text).find((sentence) => containsAny(sentence, keywords)) ?? "";
}

function splitSentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+|;\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function containsAny(value: string, keywords: string[]) {
  const lower = value.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

function getSourceLabel(sourceUrl: string | undefined) {
  if (!sourceUrl) {
    return "No direct source link";
  }

  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return "Source link";
  }
}

function buildDirectionsUrl(place: TripPlace) {
  const destination = encodeURIComponent(`${place.lat},${place.lng}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=transit`;
}
