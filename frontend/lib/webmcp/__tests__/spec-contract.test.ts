import { describe, it, expect } from 'vitest'
import type { TripBundle } from '@/lib/trip/backend-types'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { allTools, globalTools, tripTools, type ToolContext } from '../tools'
import { LIMITS, type ToolSpec } from '../types'
import { envelopeLength, OUTPUT_LIMIT } from '../fit'
import { createGenerationStore } from '../generation'

/**
 * The contract every registered tool must satisfy.
 *
 * This exists because the WebMCP spec REJECTS a registration with a duplicate name, an empty
 * name or description, or an invalid input schema — and a rejected registration is a tool that
 * simply is not there. Nothing throws, nothing logs; the tool is just missing when a judge
 * opens the Site tools list. These assertions turn the whole budget/annotation section of the
 * plan from documentation into a gate that runs unattended.
 */

const ctx: ToolContext = {
  readAppState: () => ({
    where: 'Saved Reels',
    savedReels: 6,
    verifiedPlaces: 17,
    trips: { total: 2, complete: 1, unfinished: 1 },
    nextSteps: [
      { label: 'plan a trip from saved reels', tool: 'plan_trip_from_reels', needs: 'dates' },
      { label: 'save more reels', tool: 'save_reels' },
    ],
    blocked: [],
  }),
  trips: {
    current: () => TOKYO_TRIP,
    list: async () => [TOKYO_TRIP.trip],
    load: async () => TOKYO_TRIP,
  },
  saveReel: async () => ({ id: 'sr_1', analysis_status: 'not_analyzed' }),
  analyzeReels: async () => ({ job_id: 'job_1' }),
  loadSavedReels: async () => [],
  generation: {
    store: createGenerationStore(),
    create: async () => 'trip-1',
    openStream: () => {},
    confirm: async () => false,   // never approves inside a contract test
  },
  edit: {
    add: async () => ({}),
    setDates: async () => ({}),
    replan: async () => ({ days_narrated: 0, routes_refreshed: true }),
    move: async () => ({}),
    remove: async () => ({}),
    refresh: async () => TOKYO_TRIP,
    confirm: async () => false,
  },
}

const mapDeps = {
  bundle: () => TOKYO_TRIP,
  showDay: () => {},
  selectPlace: () => {},
  setLayerMode: () => {},
  openPanel: () => {},
  view: () => ({ lng: 139.7, lat: 35.7, zoom: 12 }),
}

const specs = allTools(ctx, mapDeps)

/**
 * Guardrail #11 as a machine check: every tool whose output can carry Instagram-caption text —
 * i.e. text an attacker wrote — must declare `untrustedContentHint: true`.
 *
 * One row per registered tool, and the completeness test below fails when the registry and this
 * table disagree in EITHER direction. That is the point: the version this replaces was an
 * array of four names, and a tool that returned a caption-derived place name while declaring
 * itself trusted passed simply by not appearing in it.
 *
 * `echoes` is the audited finding, not decoration — it is what the failure message prints.
 * Two entries are deliberate over-flags: narrowing a safety hint to buy nothing is not a trade
 * worth making, so a tool that only emits camera coordinates or route labels stays flagged.
 */
const UNTRUSTED_AUDIT: Record<string, { untrusted: boolean; echoes: string }> = {
  get_app_state: { untrusted: true, echoes: 'nothing — fixed route labels and integer counts; kept flagged, not narrowed' },
  list_trips: { untrusted: true, echoes: 'trip destinations, inferred from Reel captions' },
  save_reels: { untrusted: false, echoes: 'only the URLs it was handed, and backend save errors' },
  list_saved_reels: { untrusted: true, echoes: 'reel captions verbatim and the place names extracted from them' },
  get_itinerary: { untrusted: true, echoes: 'place names and day prose written from captions' },
  get_place_evidence: { untrusted: true, echoes: 'the verbatim caption quote — the most attacker-writable string we hold' },
  plan_trip_from_reels: { untrusted: false, echoes: 'a trip id and fixed status fields' },
  get_trip_progress: { untrusted: true, echoes: 'the pipeline stage message, which names places' },
  move_place: { untrusted: true, echoes: 'the moved stop name' },
  remove_place: { untrusted: true, echoes: 'the removed stop name, on the approved AND the declined path' },
  add_place: { untrusted: true, echoes: 'the place name the agent supplied, most plausibly read off a caption' },
  set_trip_dates: { untrusted: false, echoes: 'dates and day counts only — backend errors here carry no place text' },
  replan_trip: { untrusted: false, echoes: 'day counts and a fixed narration-failure message' },
  show_on_map: { untrusted: true, echoes: 'the names of the stops it just put on screen' },
  set_map_mode: { untrusted: false, echoes: 'two fixed sentences' },
  get_map_view: { untrusted: true, echoes: 'nothing — camera and counts; kept flagged, not narrowed' },
}

const CANARY = 'Zq7Canary'

/**
 * The fixture trip with every caption-derived string replaced by a sentinel: place names, the
 * destination, the day prose, the evidence quotes. Anything a tool hands back carrying the
 * sentinel is, by construction, third-party text that reached the agent through that tool.
 */
const CANARY_TRIP: TripBundle = {
  ...TOKYO_TRIP,
  trip: {
    ...TOKYO_TRIP.trip,
    destination_hint: `${CANARY}Dest`,
    inferred_destination: `${CANARY}Dest`,
    title: `${CANARY}Title`,
    summary: `${CANARY}Summary`,
  },
  places: TOKYO_TRIP.places.map((tp, i) => ({
    ...tp,
    place: { ...tp.place, name: `${CANARY}Stop${i}`, city: `${CANARY}City`, area: `${CANARY}Area` },
    evidence_json: {
      ...tp.evidence_json,
      quote: `${CANARY}Quote`,
      quotes: [`${CANARY}Quote`],
      rationale: `${CANARY}Why`,
    },
  })),
  days: TOKYO_TRIP.days.map((d) => ({ ...d, title: `${CANARY}DayTitle`, summary: `${CANARY}DaySummary` })),
}

type SchemaProps = NonNullable<NonNullable<ToolSpec['inputSchema']>['properties']>

/**
 * One schema-valid value per parameter, chosen to reach a tool's real work rather than its
 * "what did you mean?" bail-out. Derived from the declared schema, so a new tool or a new
 * parameter is probed without anyone editing this file.
 */
function probeValue(key: string, prop: SchemaProps[string]): unknown {
  if (key.endsWith('_id')) return CANARY_TRIP.trip.id
  if (key === 'place') return '1'
  if (key === 'start_date') return '2026-08-14'
  if (key === 'end_date') return '2026-08-16'
  if (prop.type === 'array') return ['https://www.instagram.com/reel/Cabc123/']
  if (prop.type === 'integer' || prop.type === 'number') return prop.minimum ?? 1
  // Never the sentinel: an argument echoed back in an error message would read as a leak it isn't.
  return 'probe'
}

function buildArgs(spec: ToolSpec, keys: string[]): Record<string, unknown> {
  const props = spec.inputSchema?.properties ?? {}
  return Object.fromEntries(keys.filter((k) => k in props).map((k) => [k, probeValue(k, props[k])]))
}

const requiredArgs = (spec: ToolSpec) => buildArgs(spec, spec.inputSchema?.required ?? [])

/** Every enumerated value is a different code path — `target: "day"` prints stop names, `"trip"` counts them. */
function sweepEnums(base: Record<string, unknown>, props: SchemaProps): Record<string, unknown>[] {
  let sets = [base]
  for (const [key, prop] of Object.entries(props)) {
    if (!prop.enum?.length || !(key in base)) continue
    sets = sets.flatMap((s) => prop.enum!.map((v) => ({ ...s, [key]: v })))
  }
  return sets
}

/**
 * Two shapes per tool — required-only (the unfiltered call) and every declared parameter (the
 * call that reaches the work) — across both answers to an approval card, since a DECLINED edit
 * still names the stop it did not touch.
 */
function probeArgSets(spec: ToolSpec): Record<string, unknown>[] {
  const props = spec.inputSchema?.properties ?? {}
  return [...sweepEnums(requiredArgs(spec), props), ...sweepEnums(buildArgs(spec, Object.keys(props)), props)]
}

const canaryReader = {
  current: () => CANARY_TRIP,
  list: async () => [CANARY_TRIP.trip],
  load: async () => CANARY_TRIP,
}

const canaryCtx = (approves: boolean): ToolContext => ({
  ...ctx,
  trips: canaryReader,
  generation: { ...ctx.generation, store: createGenerationStore(), confirm: async () => approves },
  edit: { ...ctx.edit, refresh: async () => CANARY_TRIP, confirm: async () => approves },
})

/** Names of every tool that handed the sentinel back. This is the expectation, derived. */
async function leakingTools(): Promise<string[]> {
  const leaked = new Set<string>()
  for (const approves of [false, true]) {
    for (const spec of allTools(canaryCtx(approves), { ...mapDeps, bundle: () => CANARY_TRIP })) {
      for (const args of probeArgSets(spec)) {
        const out = await spec.execute(args)
        const text = typeof out === 'string' ? out : JSON.stringify(out)
        if (text.includes(CANARY)) leaked.add(spec.name)
      }
    }
  }
  return [...leaked].sort()
}

describe('tool spec contract', () => {
  it('registers at least the tools built so far', () => {
    expect(specs.length).toBeGreaterThanOrEqual(16)
  })

  it('has globally unique names — a duplicate is REJECTED at registration, silently', () => {
    const names = specs.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(specs.map((s) => [s.name, s] as [string, ToolSpec]))('%s: name is valid', (_n, spec) => {
    expect(spec.name.length).toBeGreaterThan(0)
    expect(spec.name.length).toBeLessThanOrEqual(LIMITS.NAME)
    expect(spec.name).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it.each(specs.map((s) => [s.name, s] as [string, ToolSpec]))('%s: description is present and within budget', (_n, spec) => {
    expect(spec.description.trim().length).toBeGreaterThan(20)
    expect(spec.description.length).toBeLessThanOrEqual(LIMITS.DESCRIPTION)
  })

  it.each(specs.map((s) => [s.name, s] as [string, ToolSpec]))('%s: input schema is well formed', (_n, spec) => {
    if (!spec.inputSchema) return
    expect(spec.inputSchema.type).toBe('object')
    for (const [key, prop] of Object.entries(spec.inputSchema.properties ?? {})) {
      expect(prop.type, `${spec.name}.${key} needs a type`).toBeTruthy()
      if (prop.description) expect(prop.description.length).toBeLessThanOrEqual(LIMITS.PARAM_DESCRIPTION)
    }
    for (const req of spec.inputSchema.required ?? []) {
      expect(Object.keys(spec.inputSchema.properties ?? {}), `${spec.name} requires "${req}" but never declares it`).toContain(req)
    }
  })

  it.each(specs.map((s) => [s.name, s] as [string, ToolSpec]))('%s: declares annotations', (_n, spec) => {
    expect(spec.annotations, `${spec.name} must state readOnlyHint`).toBeDefined()
    expect(typeof spec.annotations?.readOnlyHint).toBe('boolean')
  })

  it('declares an untrusted-content verdict for every tool — an absent hint is an unaudited tool', () => {
    const undeclared = specs.filter((s) => typeof s.annotations?.untrustedContentHint !== 'boolean')
    expect(undeclared.map((s) => s.name)).toEqual([])
  })

  it('audits every registered tool — a new one cannot pass by not being listed', () => {
    // The check this replaces named four tools in an array literal and asserted those four.
    // Nothing failed when a tool was ABSENT from it, so two tools that returned a caption-derived
    // place name while declaring themselves trusted passed the gate by never being mentioned.
    expect(Object.keys(UNTRUSTED_AUDIT).sort()).toEqual(specs.map((s) => s.name).sort())
  })

  it('matches every declared hint to its audited verdict', () => {
    for (const [name, row] of Object.entries(UNTRUSTED_AUDIT)) {
      const spec = specs.find((s) => s.name === name)
      expect(spec?.annotations?.untrustedContentHint, `${name} emits: ${row.echoes}`).toBe(row.untrusted)
    }
  })

  it('flags every tool that actually hands caption-derived text back', async () => {
    const leaking = await leakingTools()
    // Liveness: the probe must REACH trip data, or the whole check passes vacuously — which is
    // exactly how the allowlist it replaces went stale. These six echo a stop name by construction.
    expect(leaking, 'the canary probe stopped reaching trip data').toEqual(
      expect.arrayContaining([
        'get_itinerary', 'get_place_evidence', 'list_trips', 'move_place', 'remove_place', 'show_on_map',
      ]),
    )
    const unflagged = leaking.filter(
      (n) => specs.find((s) => s.name === n)?.annotations?.untrustedContentHint !== true,
    )
    expect(unflagged, 'these returned Reel-caption text while declaring themselves trusted').toEqual([])
  })

  it('a tool that asks the agent for a trip_id must declare one', async () => {
    // `additionalProperties: false` makes an undeclared parameter unsendable, not merely
    // undocumented. A tool that answers "pass its trip_id" without declaring trip_id has told the
    // agent to do the one thing its own schema rejects.
    const homeless = { current: () => null, list: async () => [], load: async () => null }
    const asks: string[] = []
    for (const spec of globalTools({ ...ctx, trips: homeless })) {
      const out = String(await spec.execute(requiredArgs(spec)))
      if (/pass its trip_id/i.test(out)) asks.push(spec.name)
    }
    expect(asks.length, 'no tool asked for a trip_id — the probe stopped reaching that branch').toBeGreaterThanOrEqual(6)
    const unusable = asks.filter((n) => {
      const props = specs.find((s) => s.name === n)?.inputSchema?.properties ?? {}
      return !('trip_id' in props)
    })
    expect(unusable, 'these ask for a trip_id the agent has no schema-valid way to send').toEqual([])
  })

  it('every tool output fits the serialized budget', async () => {
    for (const spec of specs) {
      const req = spec.inputSchema?.required ?? []
      const args: Record<string, unknown> = {}
      if (req.includes('place')) args.place = '1'
      if (req.includes('name')) args.name = 'Universal Studios Japan'
      if (req.includes('day')) args.day = 1
      if (req.includes('urls')) args.urls = ['https://www.instagram.com/reel/Cabc123/']
      if (req.includes('reel_urls')) {
        args.reel_urls = ['https://www.instagram.com/reel/Cabc123/']
        args.start_date = '2026-03-03'
        args.end_date = '2026-03-07'
      }
      const out = await spec.execute(args)
      const text = typeof out === 'string' ? out : JSON.stringify(out)
      expect(envelopeLength(text), `${spec.name} exceeded the output budget`).toBeLessThanOrEqual(OUTPUT_LIMIT)
    }
  })
})

describe('tool scoping', () => {
  it('separates always-on tools from trip-page tools', () => {
    const g = globalTools(ctx).map((s) => s.name)
    const t = tripTools(mapDeps).map((s) => s.name)
    expect(g).toContain('get_app_state')
    // Data tools are global on purpose — see tools/index.ts. Only live-map tools will be scoped.
    expect(g).toContain('get_itinerary')
    expect(t).not.toContain('get_itinerary')
    expect(t).toContain('show_on_map')
    // Overlap would mean a duplicate-name rejection the moment a trip page mounts.
    expect(g.filter((n) => t.includes(n))).toEqual([])
  })
})
