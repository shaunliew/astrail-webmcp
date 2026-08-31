import { describe, it, expect, vi } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { addPlaceTool, type EditDeps } from '../tools/edit'

/**
 * What the add_place approval card SHOWS, which is the only defence the human has against a
 * coordinate the model made up.
 *
 * Astrail resolves a place name itself and verifies the answer against the trip before storing it.
 * A `lat`/`lng` passed straight into the tool skips all of that: the backend checks only that the
 * pin is somewhere near this trip, never that it is the place named. So on that path the numbers
 * are the whole claim — and the card used to say "Add X to day 2" and nothing else, which meant a
 * user could approve a stop pinned in the wrong city without ever being shown a reason to doubt it.
 *
 * Lives in its own file rather than in `edit.test.ts`: that file is under concurrent edit for the
 * auto-replan work, and this assertion has nothing to do with it.
 */

const reader = { current: () => TOKYO_TRIP, list: async () => [TOKYO_TRIP.trip], load: async () => TOKYO_TRIP }

const deps = (over: Partial<EditDeps> = {}): EditDeps => ({
  trips: reader,
  add: vi.fn().mockResolvedValue({}),
  setDates: vi.fn().mockResolvedValue({}),
  replan: vi.fn().mockResolvedValue({ days_narrated: 3, routes_refreshed: true }),
  replanInFlight: vi.fn().mockReturnValue(false),
  move: vi.fn().mockResolvedValue({}),
  remove: vi.fn().mockResolvedValue({}),
  refresh: vi.fn().mockResolvedValue(TOKYO_TRIP),
  confirm: vi.fn().mockResolvedValue(true),
  ...over,
})

/** The summary string the user is actually shown. */
const cardText = (d: EditDeps) => String(vi.mocked(d.confirm).mock.calls[0][0])

describe('the add_place approval card', () => {
  it('shows coordinates the agent supplied, so the user can refuse a wrong pin', async () => {
    const d = deps()
    await addPlaceTool(d).execute({ name: 'Tokyo Tower', day: 1, lat: 35.6586, lng: 139.7454 })

    const summary = cardText(d)
    expect(summary).toContain('35.6586')
    expect(summary).toContain('139.7454')
    // And says WHOSE numbers they are: the card is the only place the distinction is visible.
    expect(summary).toMatch(/I supplied rather than ones Astrail looked up/i)
  })

  it('shows a negative coordinate correctly rather than dropping its sign', async () => {
    const d = deps()
    await addPlaceTool(d).execute({ name: 'Somewhere', day: 1, lat: -33.8568, lng: 151.2153 })
    expect(cardText(d)).toContain('-33.8568')
  })

  it('says nothing about coordinates when Astrail is doing the lookup', async () => {
    // The normal path. A pin line here would be a claim about numbers that do not exist yet.
    const d = deps()
    await addPlaceTool(d).execute({ name: 'Tokyo Tower', day: 1 })

    const summary = cardText(d)
    expect(summary).not.toMatch(/pinned at/i)
    expect(summary).toContain('Tokyo Tower')
  })

  it('does not ask at all when the pair is half-supplied', async () => {
    // lat without lng is bounced before the card, so there is no half-shown pin to approve.
    const d = deps()
    const out = String(await addPlaceTool(d).execute({ name: 'Tokyo Tower', day: 1, lat: 35.6586 }))
    expect(d.confirm).not.toHaveBeenCalled()
    expect(d.add).not.toHaveBeenCalled()
    expect(out).toContain('Give both lat and lng')
  })
})

/**
 * The local-script name — the second thing on this card the model asserts and the user cannot
 * otherwise check.
 *
 * `name_local` is what Astrail actually sends to the map provider for a place in Japan, because
 * Mapbox's Japan POI dataset carries no English names at all (measured against the live API:
 * "Tokyo Disneyland" returns zero features under every language, "東京ディズニーランド"
 * resolves). That makes it the string that DECIDES the pin, exactly as a supplied lat/lng does,
 * and the card follows the same rule for the same reason: a value the model chose, which the
 * lookup will act on, is shown to the person approving it.
 */
describe('the add_place approval card and the local-script name', () => {
  it('shows the local name the agent chose, because it is what will be looked up', async () => {
    const d = deps()
    await addPlaceTool(d).execute({
      name: 'Tokyo Disneyland', name_local: '東京ディズニーランド', day: 1,
    })
    expect(cardText(d)).toContain('東京ディズニーランド')
  })

  it('says nothing about a local name when none was given', async () => {
    const d = deps()
    await addPlaceTool(d).execute({ name: 'Tokyo Tower', day: 1 })
    expect(cardText(d)).not.toMatch(/looked up as/i)
  })

  it('forwards the local name to the backend, which is the only place it does anything', async () => {
    const d = deps()
    await addPlaceTool(d).execute({
      name: 'Tokyo Disneyland', name_local: '東京ディズニーランド', day: 1,
    })
    expect(d.add).toHaveBeenCalledWith(TOKYO_TRIP.trip.id, expect.objectContaining({
      name: 'Tokyo Disneyland',
      name_local: '東京ディズニーランド',
    }))
  })

  it('treats a blank local name as absent rather than sending it', async () => {
    const d = deps()
    await addPlaceTool(d).execute({ name: 'Tokyo Tower', name_local: '   ', day: 1 })
    expect(d.add).toHaveBeenCalledWith(TOKYO_TRIP.trip.id, expect.objectContaining({ name_local: null }))
    expect(cardText(d)).not.toMatch(/looked up as/i)
  })

  it('declares name_local in the tool schema, or the agent can never send it', async () => {
    const schema = addPlaceTool(deps()).inputSchema
    const props = schema?.properties as Record<string, { type?: string }> | undefined
    expect(props?.name_local?.type).toBe('string')
    // additionalProperties is false on this tool: an undeclared parameter is REJECTED, so the
    // schema is the whole of whether this fix can ever fire.
    expect(schema?.additionalProperties).toBe(false)
  })
})
