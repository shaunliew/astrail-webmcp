import { describe, it, expect, vi } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { envelopeLength, OUTPUT_LIMIT } from '../fit'
import { addPlaceTool, movePlaceTool, removePlaceTool, replanTripTool, setTripDatesTool, type EditDeps } from '../tools/edit'

const reader = { current: () => TOKYO_TRIP, list: async () => [TOKYO_TRIP.trip], load: async () => TOKYO_TRIP }

/** Every successful mutation answers with the structured envelope, so read it as one. */
const envelope = (out: unknown) => JSON.parse(String(out)) as {
  result?: string
  summaries_stale?: boolean
  next_tool?: string
  note?: string
}

const deps = (over: Partial<EditDeps> = {}): EditDeps => ({
  trips: reader,
  add: vi.fn().mockResolvedValue({}),
  setDates: vi.fn().mockResolvedValue({}),
  replan: vi.fn().mockResolvedValue({ days_narrated: 3, routes_refreshed: true }),
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
    expect(out).toContain('Akasaka Station')
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
    const out = String(await movePlaceTool(d).execute({ place: 'Tokyo', to_day: 2 }))
    expect(out).toContain('ambiguous')
    expect(d.move).not.toHaveBeenCalled()
  })

  it('is flagged untrusted, because it hands back a name that came from a caption', async () => {
    // `place.name` is extracted from an Instagram caption — text an attacker writes (guardrail
    // #11). Declaring this tool trusted tells the agent runtime that its output is safe to act
    // on, which is the one claim we cannot make about anything downstream of scraping.
    const out = String(await movePlaceTool(deps()).execute({ place: '1', to_day: 3 }))
    expect(out).toContain(TOKYO_TRIP.places[0].place.name)
    expect(movePlaceTool(deps()).annotations?.untrustedContentHint).toBe(true)
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
    const d = deps({ remove: vi.fn().mockRejectedValue(new Error('That trip or stop was not found — or trip editing is not enabled on this deployment.')) })
    const out = String(await removePlaceTool(d).execute({ place: '1' }))
    expect(out).toContain('not found')
    expect(out).not.toContain('Removed')
  })

  it('is flagged untrusted on BOTH paths, because both name the stop', async () => {
    // Declining is not a quiet path: it repeats the stop name back too, so the annotation has to
    // cover the branch where nothing was even written.
    const name = TOKYO_TRIP.places[0].place.name
    const approved = String(await removePlaceTool(deps()).execute({ place: '1' }))
    const declined = String(await removePlaceTool(deps({ confirm: vi.fn().mockResolvedValue(false) })).execute({ place: '1' }))
    expect(approved).toContain(name)
    expect(declined).toContain(name)
    expect(removePlaceTool(deps()).annotations?.untrustedContentHint).toBe(true)
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

  it('declares the trip_id its executor reads, like every sibling edit tool', () => {
    // It is registered globally, so away from a trip page it answers "pass its trip_id" — and
    // `additionalProperties: false` then rejects the agent for doing exactly that. Declaring the
    // parameter is what makes the instruction followable.
    const props = addPlaceTool(deps()).inputSchema?.properties ?? {}
    expect(Object.keys(props)).toContain('trip_id')
  })

  it('adds to a named trip when none is open', async () => {
    const d = deps({ trips: { current: () => null, list: async () => [TOKYO_TRIP.trip], load: async () => TOKYO_TRIP } })
    const out = String(await addPlaceTool(d).execute({ name: 'USJ', day: 1, trip_id: TOKYO_TRIP.trip.id }))
    expect(d.add).toHaveBeenCalledWith(TOKYO_TRIP.trip.id, expect.objectContaining({ name: 'USJ', day_number: 1 }))
    expect(out).toContain('The user approved')
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

describe('replan_trip', () => {
  it('rewrites the summaries after the stops changed', async () => {
    // Reported: after adding USJ and Osaka Castle, Day 1 still read "Start easy with Dekasan,
    // then keep the day simple with a visit to Umeda Sky Building" — describing an itinerary
    // that no longer existed.
    const d = deps()
    const out = String(await replanTripTool(d).execute({}))
    expect(d.replan).toHaveBeenCalledWith(TOKYO_TRIP.trip.id)
    expect(out).toContain('Rewrote 3 day summaries')
    expect(out).toContain('Routes recalculated')
  })

  it('asks first, because rewriting spends the user credit', async () => {
    const d = deps()
    await replanTripTool(d).execute({})
    const summary = String((d.confirm as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(summary).toContain('uses your credit')
  })

  it('rewrites NOTHING when the user declines', async () => {
    const d = deps({ confirm: vi.fn().mockResolvedValue(false) })
    const out = String(await replanTripTool(d).execute({}))
    expect(d.replan).not.toHaveBeenCalled()
    expect(out).toContain('unchanged')
  })

  it('says plainly when routes could not be recalculated', async () => {
    // Reporting a clean success when half of it failed is the thing to avoid.
    const d = deps({ replan: vi.fn().mockResolvedValue({ days_narrated: 2, routes_refreshed: false }) })
    const out = String(await replanTripTool(d).execute({}))
    expect(out).toContain('could not be recalculated')
  })

  it('does not claim success when the backend returns 502', async () => {
    const d = deps({ replan: vi.fn().mockRejectedValue(new Error('Narration failed; routes were refreshed.')) })
    const out = String(await replanTripTool(d).execute({}))
    expect(out).toContain('Narration failed')
    expect(out).not.toContain('Rewrote')
  })

  it('refreshes the page so the new wording is visible', async () => {
    const d = deps()
    await replanTripTool(d).execute({})
    expect(d.refresh).toHaveBeenCalledWith(TOKYO_TRIP.trip.id)
  })
})

describe('an edit leaves the summaries stale, and says so', () => {
  // Reported from real use: the user asked the agent to add Osaka Castle, it was added, and the
  // trip description and day plan still described the itinerary without it. `replan_trip` already
  // did this job — nothing told the agent to call it at the moment it mattered. The narrator
  // writes each day's prose FROM that day's ordered stop list (backend/genagents/narrator.py
  // build_narrator_input), and no edit endpoint touches trip_days.summary, so any edit that
  // changes which stops a day holds leaves prose describing a trip that no longer exists.
  const mutations: [string, (d: EditDeps) => Promise<unknown>][] = [
    ['add_place', (d) => Promise.resolve(addPlaceTool(d).execute({ name: 'Osaka Castle', day: 2 }))],
    ['move_place', (d) => Promise.resolve(movePlaceTool(d).execute({ place: '1', to_day: 3 }))],
    ['remove_place', (d) => Promise.resolve(removePlaceTool(d).execute({ place: '1' }))],
  ]

  it.each(mutations)('%s names replan_trip in a STRUCTURED field, not buried in prose', async (_name, run) => {
    // `plan_trip_from_reels` established the pattern for exactly this reason: agents act on
    // next_tool far more reliably than on the same instruction inside a sentence.
    const out = envelope(await run(deps()))
    expect(out.summaries_stale).toBe(true)
    expect(out.next_tool).toBe('replan_trip')
  })

  it.each(mutations)('%s does NOT replan on its own — that spends the user credit', async (_name, run) => {
    // replan_trip has its own approval card. Telling the agent is the fix; doing it is a bug.
    const d = deps()
    await run(d)
    expect(d.replan).not.toHaveBeenCalled()
  })

  it.each(mutations)('%s stays inside the serialized output budget', async (_name, run) => {
    const out = String(await run(deps()))
    expect(envelopeLength(out)).toBeLessThanOrEqual(OUTPUT_LIMIT)
  })

  it('keeps the renumbering warning the NEXT edit depends on', async () => {
    // Stale pin numbers make the following edit hit the wrong stop. The replan hint is added
    // alongside this warning, never in place of it.
    const added = envelope(await addPlaceTool(deps()).execute({ name: 'Osaka Castle', day: 2 }))
    const removed = envelope(await removePlaceTool(deps()).execute({ place: '1' }))
    expect(String(added.note)).toContain('get_itinerary')
    expect(String(removed.note)).toContain('get_itinerary')
  })
})

describe('set_trip_dates does not send the agent to replan_trip', () => {
  const NO_WEATHER = {
    ...TOKYO_TRIP,
    days: TOKYO_TRIP.days.map((d) => ({ ...d, weather_summary: null })),
  }

  it('reports the summaries as intact, because the stops did not change', async () => {
    // edit_trip_dates (backend/main.py) writes only trip_days.day_date and
    // trips.start_date/end_date; it never touches a stop, a day_number, or a summary. The
    // narrator writes each summary from that day's stop list, so the prose still holds and a
    // replan here would spend the user credit rewriting text that was already correct.
    const d = deps({ refresh: vi.fn().mockResolvedValue(NO_WEATHER) })
    const out = envelope(await setTripDatesTool(d).execute({ start_date: '2026-09-14' }))
    expect(out.summaries_stale).toBe(false)
    expect(out.next_tool).toBeUndefined()
    expect(d.replan).not.toHaveBeenCalled()
  })

  it('warns that the weather notes are the forecast for the OLD dates', async () => {
    // persist_weather runs only inside the generation pipeline (pipeline/runner.py), and
    // /trips/{id}/replan calls _refresh_trip_routes + persist_narration only. So nothing
    // refreshes a forecast after the trip moves, and re-narrating would relaunder the stale
    // one into fresh-looking prose. Say it instead.
    const out = envelope(await setTripDatesTool(deps()).execute({ start_date: '2026-09-14' }))
    expect(String(out.note)).toContain('weather')
    expect(out.next_tool).toBeUndefined()
  })

  it('says nothing about weather when the trip has none', async () => {
    const d = deps({ refresh: vi.fn().mockResolvedValue(NO_WEATHER) })
    const out = envelope(await setTripDatesTool(d).execute({ start_date: '2026-09-14' }))
    expect(String(out.note)).not.toContain('weather')
  })
})

describe('move_place records an origin, it does not promise an undo', () => {
  it('no longer advertises a move-back the tool cannot always perform', () => {
    // trip_places.sort_order is nullable by schema (20260701162954: "sort_order is null or
    // sort_order >= 0"), to_position has minimum 1, and the backend patch drops nulls
    // (model_dump(exclude_none=True)) — so a null position can never be restored.
    expect(movePlaceTool(deps()).description).not.toMatch(/(move|put) it back/i)
  })

  it('says a missing origin position was not recorded, rather than implying it can be restored', async () => {
    const unordered = {
      ...TOKYO_TRIP,
      places: TOKYO_TRIP.places.map((p) => (p.id === 'tp_akasaka' ? { ...p, sort_order: null } : p)),
    }
    const d = deps({ trips: { ...reader, current: () => unordered } })
    const out = envelope(await movePlaceTool(d).execute({ place: 'Akasaka Station', to_day: 3 }))
    expect(out.result).toContain('day 1')
    expect(out.result).not.toMatch(/(move|put) it back/i)
    expect(out.result).toMatch(/not recorded/i)
  })
})
