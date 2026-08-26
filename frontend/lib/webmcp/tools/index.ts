import type { Trip, TripBundle } from '@/lib/trip/backend-types'
import type { ToolSpec } from '../types'
import { getAppStateTool, type AppStateSnapshot } from './app-state'
import { getItineraryTool, getPlaceEvidenceTool, listTripsTool } from './trips'
import { saveReelsTool } from './reels'

/**
 * Every tool, assembled from plain readers.
 *
 * Readers are functions rather than values so a spec never closes over a stale snapshot:
 * `use-webmcp-tool` registers once and keeps the execute callback stable, so anything captured
 * by value at registration would still be day-one data on day five.
 */
export type ToolContext = {
  readAppState: () => AppStateSnapshot
  loadTrips: () => Promise<Trip[]>
  readBundle: () => TripBundle | null
  /** Saves one already-validated Instagram Reel URL. Validation stays in the tool. */
  saveReel: (url: string) => Promise<unknown>
}

/** Live for the whole /app shell. */
export function globalTools(ctx: ToolContext): ToolSpec[] {
  return [
    getAppStateTool(ctx.readAppState),
    listTripsTool(ctx.loadTrips),
    saveReelsTool({ save: ctx.saveReel }),
  ]
}

/** Registered only on a trip page; unregistered on navigation away. */
export function tripTools(ctx: ToolContext): ToolSpec[] {
  return [getItineraryTool(ctx.readBundle), getPlaceEvidenceTool(ctx.readBundle)]
}

export function allTools(ctx: ToolContext): ToolSpec[] {
  return [...globalTools(ctx), ...tripTools(ctx)]
}
