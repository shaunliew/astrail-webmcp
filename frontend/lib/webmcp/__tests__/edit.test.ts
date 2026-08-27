import { describe, it, expect, vi } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { movePlaceTool, removePlaceTool, type EditDeps } from '../tools/edit'

const reader = { current: () => TOKYO_TRIP, list: async () => [TOKYO_TRIP.trip], load: async () => TOKYO_TRIP }

const deps = (over: Partial<EditDeps> = {}): EditDeps => ({
  trips: reader,
  move: vi.fn().mockResolvedValue({}),
  remove: vi.fn().mockResolvedValue({}),
  refresh: vi.fn().mockResolvedValue(TOKYO_TRIP),
  confirm: vi.fn().mockResolvedValue(true),
  ...over,
})

describe('move_place', () => {
  it('moves by pin number and reports where it came from', async () => {
    const d = deps()
    const out = String(await movePlaceTool(d).execute({ place: '1', to_day: 3 }))
    expect(d.move).toHaveBeenCalledWith(TOKYO_TRIP.trip.id, expect.any(String), { day_number: 3 })
    expect(out).toContain('Senso-ji Temple')
    expect(out).toContain('day 3')
    expect(out).toContain('It was on day 1') // reversibility without a UI: the agent can undo
  })

  it('converts a 1-based position to the 0-based sort_order the backend stores', async () => {
    // The user counts stops from 1; the column starts at 0. Getting this wrong silently
    // reorders the day by one slot every single time.
    const d = deps()
    await movePlaceTool(d).execute({ place: '1', to_position: 1 })
    expect(d.move).toHaveBeenCalledWith(TOKYO_TRIP.trip.id, expect.any(String), { sort_order: 0 })
  })

  it('refuses a no-op instead of calling the backend', async () => {
    const d = deps()
    const out = String(await movePlaceTool(d).execute({ place: '1' }))
    expect(d.move).not.toHaveBeenCalled()
    expect(out).toContain('to_day, to_position, or both')
  })

  it('does not report success when the backend rejects the edit', async () => {
    const d = deps({
      move: vi.fn().mockRejectedValue(new Error('This trip cannot be edited right now — it may still be generating.')),
    })
    const out = String(await movePlaceTool(d).execute({ place: '1', to_day: 2 }))
    expect(out).toContain('cannot be edited')
    expect(out).not.toContain('Moved')
    expect(d.refresh).not.toHaveBeenCalled()
  })

  it('refreshes the page before claiming the map redrew', async () => {
    // The tool must not resolve until the UI reflects the change, or the agent tells the user
    // "done" while the map still shows the old route.
    const d = deps()
    await movePlaceTool(d).execute({ place: '1', to_day: 2 })
    expect(d.refresh).toHaveBeenCalledWith(TOKYO_TRIP.trip.id)
  })

  it('passes an ambiguous place straight through rather than guessing', async () => {
    const d = deps()
    const out = String(await movePlaceTool(d).execute({ place: 'Shibuya', to_day: 2 }))
    expect(out).toContain('ambiguous')
    expect(d.move).not.toHaveBeenCalled()
  })
})

describe('remove_place', () => {
  it('asks before removing, then reports the user approved', async () => {
    const d = deps()
    const out = String(await removePlaceTool(d).execute({ place: '1' }))
    expect(d.confirm).toHaveBeenCalled()
    expect(String((d.confirm as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('cannot be undone')
    expect(d.remove).toHaveBeenCalled()
    expect(out).toContain('The user approved')
  })

  it('removes NOTHING when the user declines', async () => {
    const d = deps({ confirm: vi.fn().mockResolvedValue(false) })
    const out = String(await removePlaceTool(d).execute({ place: '1' }))
    expect(d.remove).not.toHaveBeenCalled()
    expect(out).toContain('declined')
    expect(out).toContain('still on the trip')
  })

  it('warns that pin numbers shift, so the agent re-reads before reusing them', async () => {
    // Stale pin numbers after a removal would make the NEXT edit hit the wrong stop.
    const out = String(await removePlaceTool(deps()).execute({ place: '1' }))
    expect(out).toContain('renumbered')
    expect(out).toContain('get_itinerary')
  })

  it('does not claim success when the backend fails', async () => {
    const d = deps({ remove: vi.fn().mockRejectedValue(new Error('That trip or stop was not found.')) })
    const out = String(await removePlaceTool(d).execute({ place: '1' }))
    expect(out).toContain('not found')
    expect(out).not.toContain('Removed')
  })
})
