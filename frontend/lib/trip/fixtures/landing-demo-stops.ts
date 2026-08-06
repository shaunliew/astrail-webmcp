/* Snapshot of a real generated trip's placed stops for the landing reveal map
   (StoryRevealMap). Trip: "Tokyo Bites at an Easy Pace", 3 days, generated
   2026-08-06 through the live pipeline — coordinates are the pipeline's own
   geocoded values, never hand-invented (Guardrail #1). Only what the landing
   map needs is snapshotted here (no evidence, no user data): to refresh,
   regenerate a demo trip in the app and re-export name/lat/lng/day/order. */

export type LandingDemoStop = {
  name: string
  lat: number
  lng: number
  day: number
  order: number
}

export const LANDING_DEMO_STOPS: LandingDemoStop[] = [
  { name: 'RED° TOKYO TOWER', lat: 35.6585696, lng: 139.745484, day: 1, order: 0 },
  { name: 'Tonkatsu Hajime', lat: 35.68639539, lng: 139.77539083, day: 1, order: 1 },
  { name: 'Himuka Shokudo', lat: 35.7023717, lng: 139.7713428, day: 2, order: 0 },
  { name: 'Pasta Mama Shinjuku', lat: 35.69159173, lng: 139.70268304, day: 2, order: 1 },
  { name: "ESPRESSO D' WORKS yellow", lat: 35.659963137903, lng: 139.69883438306, day: 3, order: 0 },
]
