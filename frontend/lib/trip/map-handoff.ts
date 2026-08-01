/* Seamless dashboard → workspace camera handoff.
 *
 * The /app/trips dashboard and the /app/trip/[id] workspace drive the SAME shared Mapbox
 * instance (it survives the client-side route change). When you click "Open trip" from the
 * dashboard, the map is already framed on that trip — so the workspace should settle into its
 * own panel geometry rather than re-fly the whole camera from scratch, which reads as a
 * redundant zoom.
 *
 * This is a module singleton, deliberately: the module isn't reloaded across an in-app
 * navigation, so a value written on the dashboard is readable on the workspace. It's a
 * one-shot — consuming it clears it, so a later direct load or a generation→trip handoff
 * (which never sets it) still frames normally. */

let framedTripId: string | null = null

/** The dashboard calls this once it has framed a trip on the shared map. */
export function markTripFramed(tripId: string): void {
  framedTripId = tripId
}

/**
 * The workspace calls this on first framing. Returns true (and clears the flag) only if the
 * shared map is arriving already framed on this exact trip — i.e. a seamless handoff.
 */
export function consumeTripFramed(tripId: string): boolean {
  const inherited = framedTripId === tripId
  framedTripId = null
  return inherited
}
