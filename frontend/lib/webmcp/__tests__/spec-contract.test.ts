import { describe, it, expect } from 'vitest'
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
  saveReel: async () => ({}),
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

describe('tool spec contract', () => {
  it('registers at least the tools built so far', () => {
    expect(specs.length).toBeGreaterThanOrEqual(15)
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

  it('flags every tool that can echo Instagram caption text as untrusted', () => {
    // Guardrail #11 as a machine check: anything downstream of scraping is attacker-writable.
    const captionDerived = ['get_app_state', 'list_trips', 'get_itinerary', 'get_place_evidence']
    for (const name of captionDerived) {
      const spec = specs.find((s) => s.name === name)
      expect(spec, `${name} missing from the registry`).toBeDefined()
      expect(spec?.annotations?.untrustedContentHint, `${name} can emit caption text and must be flagged untrusted`).toBe(true)
    }
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
