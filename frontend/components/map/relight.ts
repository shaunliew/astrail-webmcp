// The signature moment: generation completes and the map relights night -> dawn
// (docs/DESIGN-DRAFT.md §6.3 — "Plan by night, travel by dawn").
//
// Mapbox interpolates a lightPreset change rather than snapping to it: the config feeds
// ambient light, directional light and fog through the same transitionable machinery as
// any other style property. But it honours the style's transition duration, which
// defaults to 300ms — so the 2s beat has to be asked for explicitly.

export const RELIGHT_MS = 2000

/** Reduced motion gets the end state, not the journey. */
export function relightDurationMs(): number {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return RELIGHT_MS
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : RELIGHT_MS
}
