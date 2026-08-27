import { describe, it, expect, vi } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { addPlaceTool, movePlaceTool, removePlaceTool, setTripDatesTool, type EditDeps } from '../tools/edit'

const reader = { current: () => TOKYO_TRIP, list: async () => [TOKYO_TRIP.trip], load: async () => TOKYO_TRIP }

const deps = (over: Partial<EditDeps> = {}): EditDeps => ({
  trips: reader,
  add: vi.fn().mockResolvedValue({}),
  setDates: vi.fn().mockResolvedValue({}),
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

describe('add_place', () => {
  it('asks before adding, then reports what it did', async () => {
    // This is what the agent could not do when a user asked it to "add USJ to Day 1".
    const d = deps()
    const out = String(await addPlaceTool(d).execute({ name: 'Universal Studios Japan', day: 1 }))
    expect(d.confirm).toHaveBeenCalled()
    expect(d.add).toHaveBeenCalledWith(TOKYO_TRIP.trip.id, expect.objectContaining({
      name: 'Universal Studios Japan', day_number: 1,
    }))
    expect(out).toContain('The user approved')
  })

  it('adds NOTHING when the user declines', async () => {
    const d = deps({ confirm: vi.fn().mockResolvedValue(false) })
    const out = String(await addPlaceTool(d).execute({ name: 'USJ', day: 1 }))
    expect(d.add).not.toHaveBeenCalled()
    expect(out).toContain('declined')
  })

  it('tells the agent the place has no Reel evidence behind it', async () => {
    // Astrail's promise is that every claim is evidence-backed. A place the user asked for is
    // still honest provenance, but it is NOT a Reel, and the agent must not imply otherwise.
    const d = deps()
    await addPlaceTool(d).execute({ name: 'USJ', day: 1 })
    expect(String((d.confirm as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('no Reel evidence')
  })

  it('refuses half a coordinate rather than sending a broken pair', async () => {
    const d = deps()
    const out = String(await addPlaceTool(d).execute({ name: 'USJ', day: 1, lat: 34.6 }))
    expect(d.add).not.toHaveBeenCalled()
    expect(out).toContain('both lat and lng')
  })

  it('passes the backend request for coordinates straight through', async () => {
    // The backend returns 422 rather than inventing a coordinate. The agent needs to see that
    // and ask the user, not silently drop the request.
    const d = deps({ add: vi.fn().mockRejectedValue(new Error('Could not resolve "USJ" — supply lat and lng.')) })
    const out = String(await addPlaceTool(d).execute({ name: 'USJ', day: 1 }))
    expect(out).toContain('supply lat and lng')
    expect(out).not.toContain('approved. Added')
  })

  it('warns that pin numbers shift after an insert', async () => {
    const out = String(await addPlaceTool(deps()).execute({ name: 'USJ', day: 1, position: 1 }))
    expect(out).toContain('get_itinerary')
  })
})

describe('set_trip_dates', () => {
  it('shifts the trip and says so', async () => {
    // The other thing the agent could not do: "change the dates from Aug 27-29 to Aug 28-30".
    const d = deps()
    const out = String(await setTripDatesTool(d).execute({ start_date: '2026-08-28', end_date: '2026-08-30' }))
    expect(d.setDates).toHaveBeenCalledWith(TOKYO_TRIP.trip.id, {
      start_date: '2026-08-28', end_date: '2026-08-30',
    })
    expect(out).toContain('kept its stops')
  })

  it('shows the user the before and after before touching anything', async () => {
    const d = deps()
    await setTripDatesTool(d).execute({ start_date: '2026-08-28' })
    const summary = String((d.confirm as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(summary).toContain('2026-08-28')
    expect(summary).toContain(TOKYO_TRIP.trip.start_date!)
  })

  it('rejects a reversed range without calling the backend', async () => {
    const d = deps()
    const out = String(await setTripDatesTool(d).execute({ start_date: '2026-08-30', end_date: '2026-08-28' }))
    expect(d.setDates).not.toHaveBeenCalled()
    expect(out).toContain('before start_date')
  })

  it('rejects a malformed date', async () => {
    const out = String(await setTripDatesTool(deps()).execute({ start_date: '28 Aug' }))
    expect(out).toContain('YYYY-MM-DD')
  })

  it('surfaces the backend refusal to drop a day', async () => {
    // 409 trip_range_too_short. Losing someone's day silently would be far worse than failing.
    const d = deps({ setDates: vi.fn().mockRejectedValue(new Error('This trip has 3 days but the new range covers 2. Remove stops first.')) })
    const out = String(await setTripDatesTool(d).execute({ start_date: '2026-08-28', end_date: '2026-08-29' }))
    expect(out).toContain('Remove stops first')
    expect(out).not.toContain('approved. The trip now runs')
  })

  it('changes nothing when the user declines', async () => {
    const d = deps({ confirm: vi.fn().mockResolvedValue(false) })
    const out = String(await setTripDatesTool(d).execute({ start_date: '2026-08-28' }))
    expect(d.setDates).not.toHaveBeenCalled()
    expect(out).toContain('unchanged')
  })
})
