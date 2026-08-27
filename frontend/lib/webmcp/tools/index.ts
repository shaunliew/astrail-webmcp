import type { ToolSpec } from '../types'
import { getAppStateTool, type AppStateSnapshot } from './app-state'
import { getItineraryTool, getPlaceEvidenceTool, listTripsTool, type TripReader } from './trips'
import { saveReelsTool } from './reels'

/**
 * Every tool, assembled from plain readers.
 *
 * Readers are functions rather than values so a spec never closes over a stale snapshot:
 * `use-webmcp-tool` registers once and keeps the execute callback stable, so anything captured
 * by value at registration would still be first-render data days later.
 */
export type ToolContext = {
  readAppState: () => AppStateSnapshot
  trips: TripReader
  /** Saves one already-validated Instagram Reel URL. Validation stays in the tool. */
  saveReel: (url: string) => Promise<unknown>
}

/**
 * Everything a signed-in user's agent can do, available from any /app route.
 *
 * Data tools live here deliberately. The user asks "what's on day 2 of my Kyoto trip?" without
 * navigating first, so a tool that only exists on the trip page would be invisible exactly when
 * it is wanted — and the agent cannot navigate to summon one mid-call.
 */
export function globalTools(ctx: ToolContext): ToolSpec[] {
  return [
    getAppStateTool(ctx.readAppState),
    listTripsTool(ctx.trips),
    saveReelsTool({ save: ctx.saveReel }),
    getItineraryTool(ctx.trips),
    getPlaceEvidenceTool(ctx.trips),
  ]
}

/**
 * Reserved for tools that act on the LIVE map instance, which exists only on a trip page:
 * show_on_map, set_map_mode. Registering those globally would just fail with "no map here".
 */
export function tripTools(_ctx: ToolContext): ToolSpec[] {
  return []
}

export function allTools(ctx: ToolContext): ToolSpec[] {
  return [...globalTools(ctx), ...tripTools(ctx)]
}
