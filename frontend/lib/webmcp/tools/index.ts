import type { ToolSpec } from '../types'
import { getAppStateTool, type AppStateSnapshot } from './app-state'
import { getItineraryTool, getPlaceEvidenceTool, listTripsTool, type TripReader } from './trips'
import { listSavedReelsTool, saveReelsTool, type SavedReelLike, type SavedReelSummary } from './reels'
import { getTripProgressTool, planTripFromReelsTool, type GenerationDeps } from './generation'
import { addPlaceTool, movePlaceTool, removePlaceTool, replanTripTool, setTripDatesTool, type EditDeps } from './edit'
import { getMapViewTool, setMapModeTool, showOnMapTool, type MapDeps } from './map'
import { getRememberedPreferencesTool, type PreferenceReader } from './preferences'

/**
 * Every tool, assembled from plain readers.
 *
 * Readers are functions rather than values so a spec never closes over a stale snapshot:
 * `useRegisterTool` registers once and keeps the execute callback stable, so anything captured
 * by value at registration would still be first-render data days later.
 */
export type ToolContext = {
  readAppState: () => AppStateSnapshot
  trips: TripReader
  /** Saves one already-validated Instagram Reel URL. Validation stays in the tool. */
  saveReel: (url: string) => Promise<SavedReelLike>
  /** Queues place extraction for saved reels. One background job per batch — the backend permits
   *  a single active organize job per user, so the tool batches rather than looping. */
  analyzeReels: (savedReelIds: string[]) => Promise<unknown>
  /** Reads the saved-reel library so the agent can plan from it without re-pasting links. */
  loadSavedReels: () => Promise<SavedReelSummary[]>
  /**
   * Takes the user to their library once a save has landed, and resolves when they are there.
   *
   * Optional: without a router behind it (tests, the spec contract) the tools still work, they
   * simply move nothing.
   */
  revealSavedReels?: () => Promise<void>
  generation: GenerationDeps
  /** Itinerary mutations. Gated server-side by WEBMCP_EDITS_ENABLED. */
  edit: Omit<EditDeps, 'trips'>
  /** Reads the user's own stored mem0 memories. Not optional: the tool is always registered
   *  so it is always covered by the spec contract's untrusted audit, and it reports a
   *  disabled or unreachable store honestly rather than being absent. */
  preferences: PreferenceReader
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
    saveReelsTool({ save: ctx.saveReel, analyze: ctx.analyzeReels, reveal: ctx.revealSavedReels }),
    listSavedReelsTool({ load: ctx.loadSavedReels }),
    getItineraryTool(ctx.trips),
    getPlaceEvidenceTool(ctx.trips),
    planTripFromReelsTool(ctx.generation),
    getTripProgressTool(ctx.generation.store),
    movePlaceTool({ ...ctx.edit, trips: ctx.trips }),
    removePlaceTool({ ...ctx.edit, trips: ctx.trips }),
    addPlaceTool({ ...ctx.edit, trips: ctx.trips }),
    setTripDatesTool({ ...ctx.edit, trips: ctx.trips }),
    replanTripTool({ ...ctx.edit, trips: ctx.trips }),
    getRememberedPreferencesTool(ctx.preferences),
  ]
}

/**
 * Tools that act on the LIVE map instance, which exists only on a trip page. Registering these
 * globally would just fail with "no map here" — noise the agent has to learn to route around.
 */
export function tripTools(deps: MapDeps): ToolSpec[] {
  return [showOnMapTool(deps), setMapModeTool(deps), getMapViewTool(deps)]
}

export function allTools(ctx: ToolContext, map: MapDeps): ToolSpec[] {
  return [...globalTools(ctx), ...tripTools(map)]
}
