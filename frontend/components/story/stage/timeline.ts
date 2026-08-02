/* The master timeline for the One-Stage scroll story.
   One scroll runway; every layer keys its transforms off these windows.
   All values are fractions of total runway progress (0→1).

   SLICE (beats 0→2). When the grammar is approved, later beats extend this
   table — the engine doesn't change. */

export const RUNWAY_VH = 1000 // slice runway: ~10 screens for 3 beats

export const T = {
  /* Beat 0 — cold open. Idle loop holds until the user scrolls. */
  heroCopyOut: [0.06, 0.12], // headline fades as the camera starts moving
  zoom: [0.1, 0.24], // camera enlarges INTO the phone (scale 1 → 7)
  zoomBlur: [0.16, 0.24], // motion blur sells the dive + masks the art switch
  beat0Out: [0.2, 0.245], // cold-open dissolves away inside the zoom
  beat1In: [0.18, 0.24], // POV phone fades in mid-zoom

  /* Beat 1 — first-person scroll. Scroll = his thumb. */
  phone: [0.24, 0.6], // flick-scrub window (3 flick cycles)
  phonePush: [0.24, 0.6], // slow push-in during the POV

  /* Beat 1 → 2 transition (two variants, ?t12=star|pull) */
  t12: [0.6, 0.72],

  /* Beat 2 — the spark. */
  spark: [0.66, 1],
  sparkCopy: [0.78, 0.86],

  /* Slice end-cap */
  cap: [0.95, 1],
} as const

/* Beat-1 clip: flick cycles measured by frame-diff probe (2026-08-02).
   Rest→flick→settle segments in clip seconds; 6.1s+ is a static frame (cut). */
export const FLICK_SEGMENTS: Array<[number, number]> = [
  [0.1, 2.1],
  [2.1, 4.2],
  [4.2, 6.1],
]

/* Map 0→1 phone-window progress onto clip time through the flick segments. */
export function flickTime(p: number): number {
  const n = FLICK_SEGMENTS.length
  const clamped = Math.min(Math.max(p, 0), 0.9999)
  const i = Math.floor(clamped * n)
  const frac = clamped * n - i
  const [start, end] = FLICK_SEGMENTS[i]
  return start + frac * (end - start)
}
