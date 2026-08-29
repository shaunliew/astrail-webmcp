import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, render, waitFor } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import { buildTrailNumbers, placesForDay } from '@/lib/trip/selectors'
import type { Trip, TripPlace } from '@/lib/trip/backend-types'
import type { Entitlement } from '@/lib/entitlement'

/**
 * The submission video's claims, executed rather than believed.
 *
 * `docs/webmcp/VIDEO-SCRIPT.md` quotes the exact prompts a human will type on camera and states
 * exactly what each one returns. Every claim in it was checked by hand, once. Nothing kept them
 * true: a tool description, a fixture reordering or a formatter tweak silently falsifies a beat,
 * and the discovery happens while recording — or in front of a judge.
 *
 * So this reads the numbers and pin references OUT OF THE SCRIPT and runs them against the real
 * tools. Restating the script's own strings in a second file proves nothing, because both drift
 * together; deriving the expectation from the doc means editing the doc re-aims the test.
 *
 * Registration is mounted for real — the same reason `public-sample-tools.test.tsx` does it. The
 * annotations and schemas a judge inspects in the Site tools list are the ones that reach
 * `document.modelContext`, not the ones a factory returned, and those are two code paths (see
 * `RegisterTools` → `useRegisterTool`, which rebuilds the payload field by field).
 *
 * Lives here rather than beside the README contract test because that machinery — the hoisted
 * session/navigation mocks that make a signed-out `/app/trip/demo` mountable — is local to this
 * directory. Reading a doc is just a path; mounting the page is not.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT (three script claims that are false TODAY — they
 * are reported, not encoded, because writing a test around what the code happens to do would
 * quietly bless the wrong side):
 *
 *  1. VIDEO-SCRIPT.md:90 — stop 4 "says it has no Reel". It does not. `get_place_evidence`
 *     prints the no-Reel line ONLY for an `evidence_kind: 'reel_quote'` stop whose URL is missing
 *     (lib/webmcp/tools/trips.ts:139-143); on a `suggested_by_astrail` stop there is no Reel to
 *     miss, so no line is owed and none is printed. The stop-4 output is header + rationale +
 *     `research:`, and nothing else.
 *  2. VIDEO-SCRIPT.md:104,107 — "Now show it in 3D" / "the buildings extrude". No tool sets 3D:
 *     `set_map_mode`'s enum is route|hub (lib/webmcp/tools/map.ts:129) and the prompt returns
 *     `mode must be "route" or "hub".` The buildings layer is `minzoom: 15`
 *     (components/map/TripMap.tsx:632) and the deepest tool-driven camera is zoom 14
 *     (TripMap.tsx:754 day framing, TripMap.tsx:834 place fly), so no tool can extrude a building.
 *  3. VIDEO-SCRIPT.md:67 — get_app_state answers with "the six tools that work". Its output names
 *     FIVE (it does not recommend itself). Six is the registered count — what the Site tools list
 *     and the on-page chip show. Both numbers are pinned below, separately and honestly.
 */

const SCRIPT = readFileSync(resolve(process.cwd(), '..', 'docs/webmcp/VIDEO-SCRIPT.md'), 'utf8')

/** Number words as the script writes them. A count is a claim; it has to be read, not assumed. */
const WORDS: Record<string, number> = { five: 5, six: 6, thirteen: 13, sixteen: 16 }
const wordToCount = (word: string | undefined): number | null =>
  word ? WORDS[word.toLowerCase()] ?? null : null

/** "the six tools that work" — the 0:35 beat's count of what a signed-out visitor is offered. */
const SCRIPT_SIGNED_OUT_TOOLS = wordToCount(SCRIPT.match(/the (\w+) tools that work/)?.[1])
/** "Sixteen tools in two scopes" — the 2:35 beat's count of the whole surface. */
const SCRIPT_TOTAL_TOOLS = wordToCount(SCRIPT.match(/"(\w+) tools in two scopes/)?.[1])
/** The pin numbers the presenter is told to TYPE, in the order the script types them. */
const SCRIPT_STOP_PROMPTS = [...SCRIPT.matchAll(/^> \*\*[^*]*\bstop (\d+)[^*]*\*\*$/gm)]
  .map((m) => Number(m[1]))
/** "Show me day 2 on the map" — the day the 1:35 beat asks for. */
const SCRIPT_MAP_DAY = Number(SCRIPT.match(/^> \*\*Show me day (\d+) on the map\*\*$/m)?.[1])
/** "Stop 4 is **Ichiran Shibuya**, `suggested_by_astrail`" — the contrast half of the 1:00 beat. */
const SCRIPT_SUGGESTED = SCRIPT.match(/Stop (\d+) is \*\*([^*]+)\*\*, `([a-z_]+)`/)

const h = vi.hoisted(() => ({
  pathname: '/app/trip/demo',
  signedIn: false,
  listTrips: vi.fn<() => Promise<Trip[]>>(),
  listSavedReelCards: vi.fn<() => Promise<{ places: { name: string }[] }[]>>(),
}))

vi.mock('next/navigation', () => ({ usePathname: () => h.pathname }))

vi.mock('@/lib/trip/supabase-api', () => ({
  listTrips: () => h.listTrips(),
  getTrip: vi.fn(),
}))

vi.mock('@/lib/reels/api', () => ({
  listSavedReelCards: () => h.listSavedReelCards(),
  captureSavedReel: vi.fn(),
  startOrganize: vi.fn(),
}))

// The one seam the signed-out gate reads, and the same call every withheld tool makes.
vi.mock('@/lib/supabase/session', () => ({
  getAccessToken: () =>
    h.signedIn ? Promise.resolve('test-token') : Promise.reject(new Error('Not signed in')),
}))

// Spread the real module: `ApiError` is a class the generation tool branches on with `instanceof`.
vi.mock('@/lib/trip/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/trip/api')>(),
  addTripPlace: vi.fn(), deleteTripPlace: vi.fn(), editTripDates: vi.fn(),
  editTripPlace: vi.fn(), generateTrip: vi.fn(), replanTrip: vi.fn(),
}))

vi.mock('@/lib/entitlement', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/entitlement')>(),
  readEntitlement: (): Promise<Entitlement> =>
    Promise.resolve({ plan: 'trial', lifetimeTripCount: 0, seatRequestedAt: null }),
}))

vi.mock('@/components/generation/GenerationProvider', async () => {
  const { createGenerationStore } = await import('@/lib/webmcp/generation')
  const store = createGenerationStore()
  return { useGeneration: () => ({ store, reserve: () => null }) }
})

// Only `getMap` is reached, and only by get_map_view. Mocking it keeps Mapbox out of this file.
vi.mock('@/components/map/MapProvider', () => ({
  useSharedMap: () => ({ getMap: () => null }),
}))

const { WebMcpRegistryProvider } = await import('../WebMcpRegistry')
const { default: GlobalTools } = await import('../GlobalTools')
const { default: TripTools } = await import('../TripTools')

/** A tool exactly as the browser receives it — schema and annotations included, not just a name. */
type OfferedTool = {
  name: string
  description: string
  inputSchema?: {
    properties?: Record<string, { type: string; description?: string; enum?: readonly string[] }>
    required?: string[]
  }
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean }
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

const registered: OfferedTool[] = []
const names = () => registered.map((t) => t.name)
const offered = (name: string): OfferedTool => {
  const tool = registered.find((t) => t.name === name)
  if (!tool) throw new Error(`${name} was never offered — [${names().join(', ')}]`)
  return tool
}

/** Calls a tool the way the browser would, and unwraps the MCP envelope it answers in. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const tool = offered(name)
  let res: unknown
  // Wrapped because every call reports through the registry's activity rail, which is React state.
  await act(async () => { res = await tool.execute(args) })
  return (res as { content: { text: string }[] }).content.map((c) => c.text).join('\n')
}

beforeEach(() => {
  registered.length = 0
  h.pathname = '/app/trip/demo'
  h.signedIn = false
  // A signed-out visitor gets exactly this from both reads.
  h.listTrips.mockRejectedValue(new Error('Not signed in'))
  h.listSavedReelCards.mockRejectedValue(new Error('Not signed in'))
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: { registerTool: (tool: OfferedTool) => { registered.push(tool) } },
  })
})

afterEach(() => {
  Reflect.deleteProperty(document, 'modelContext')
})

/** `/app/trip/demo`, mounted the way the /app layout and the trip page mount it. */
function mountSampleTrail() {
  return render(
    <WebMcpRegistryProvider>
      <GlobalTools />
      <TripTools
        bundle={TOKYO_TRIP}
        readOnly
        showDay={vi.fn()}
        selectPlace={vi.fn()}
        setLayerMode={vi.fn()}
        openPanel={vi.fn()}
        refresh={vi.fn(async () => TOKYO_TRIP)}
      />
    </WebMcpRegistryProvider>,
  )
}

/** The page-scoped half on its own — the tools that leave when the trip page does. */
function mountTripScopeOnly() {
  return render(
    <WebMcpRegistryProvider>
      <TripTools
        bundle={TOKYO_TRIP}
        readOnly
        showDay={vi.fn()}
        selectPlace={vi.fn()}
        setLayerMode={vi.fn()}
        openPanel={vi.fn()}
        refresh={vi.fn(async () => TOKYO_TRIP)}
      />
    </WebMcpRegistryProvider>,
  )
}

const signIn = () => {
  h.signedIn = true
  h.listTrips.mockResolvedValue([])
  h.listSavedReelCards.mockResolvedValue([])
}

/** Place names come from Reel captions, so they can carry anything — including regex syntax. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The stop the map paints pin N on — the address space the script tells the presenter to type. */
function stopAtPin(pin: number): TripPlace {
  const [id] = [...buildTrailNumbers(TOKYO_TRIP).entries()].find(([, n]) => n === pin) ?? []
  const stop = TOKYO_TRIP.places.find((tp) => tp.id === id)
  if (!stop) throw new Error(`The sample trail has no pin ${pin}`)
  return stop
}

describe('the submission video script, run against the code it describes', () => {
  it('parses the script at all (guards the guard)', () => {
    /* Every assertion below is derived from these. If a beat is reworded and a regex stops
       matching, the expectations silently become `null` and the file passes while checking
       nothing — the exact failure mode the README contract test was found in.

       Presence only, never the values: the script's numbers belong in the tests that run them
       against the code. Pinning them HERE too would make an honest script edit redden a test
       whose name says "parses", pointing the reader at the wrong thing. */
    expect(SCRIPT_SIGNED_OUT_TOOLS, 'no readable count in "the N tools that work"').not.toBeNull()
    expect(SCRIPT_TOTAL_TOOLS, 'no readable count in "N tools in two scopes"').not.toBeNull()
    expect(SCRIPT_STOP_PROMPTS, 'the 1:00 beat types two stop numbers').toHaveLength(2)
    expect(SCRIPT_MAP_DAY, 'no "Show me day N on the map" prompt').toBeGreaterThan(0)
    expect(SCRIPT_SUGGESTED?.slice(1), 'no "Stop N is **Name**, `kind`" line').toHaveLength(3)
  })

  describe('0:35 — "What can I do here?"', () => {
    it('offers exactly the number of tools the script says work signed out', async () => {
      mountSampleTrail()
      await waitFor(() => { expect(names().length).toBe(SCRIPT_SIGNED_OUT_TOOLS) })
    })

    it('answers with the sample trail, the missing account, and what needs one', async () => {
      /* Three of the four things the script promises this beat says. The fourth — the tool count —
         is the test below, because the output and the tool list carry different numbers. */
      mountSampleTrail()
      await waitFor(() => { expect(names()).toHaveLength(6) })
      const out = await callTool('get_app_state')
      expect(out, 'the script opens on "the public sample trail"').toMatch(
        /^You are on: .*public sample trail/m,
      )
      expect(out, 'the script: "there is no account"').toMatch(/^Account: +none — you are signed out/m)
      expect(out, 'the script: "it will say nothing about your own library"').toMatch(
        /say nothing about this person's own reels, places or trips/i,
      )
      expect(out, 'the script: "saving, planning and editing need an account"').toMatch(
        /^Blocked: +.*saving Reels, planning a trip and editing an itinerary all need an account/m,
      )
    })

    it('recommends only tools it also offered, and together they are the six', async () => {
      /* The honest form of the script's "the six tools that work". `get_app_state` names FIVE —
         it does not recommend itself — and the sixth is the tool being called. A beat that
         recommended a seventh, or one the browser was never given, would be an agent invited to
         call something that is not there: the failure this whole integration exists to remove. */
      mountSampleTrail()
      await waitFor(() => { expect(names()).toHaveLength(6) })
      const recommended = [...(await callTool('get_app_state')).matchAll(/→ (\w+)/g)].map((m) => m[1])
      expect(new Set([...recommended, 'get_app_state'])).toEqual(new Set(names()))
      expect(names()).toHaveLength(SCRIPT_SIGNED_OUT_TOOLS!)
    })
  })

  describe('1:00 — the evidence contrast', () => {
    it('answers the first typed stop with a Reel and a verbatim caption quote', async () => {
      /* Keyed on the PIN NUMBER the script types, never on the place name: the pin is what gets
         typed on camera, and a fixture reordering that moves a suggested stop into pin 1 must
         redden here rather than during the take. */
      const pin = SCRIPT_STOP_PROMPTS[0]
      const stop = stopAtPin(pin)
      expect(stop.evidence_json.evidence_kind, `pin ${pin} must be reel-sourced`).toBe('reel_quote')
      expect(SCRIPT, 'the script names this stop by name too').toContain(stop.place.name)

      mountSampleTrail()
      await waitFor(() => { expect(names()).toHaveLength(6) })
      const out = await callTool('get_place_evidence', { place: String(pin) })
      expect(out).toMatch(new RegExp(`^${pin} ${esc(stop.place.name)}`))
      // The Reel, as a real Instagram URL — not a research page wearing the label.
      expect(out).toMatch(/^reel: https:\/\/www\.instagram\.com\/reel\/[A-Za-z0-9_-]+\/$/m)
      // Verbatim, character for character. `tokyo-trip.test.ts` proves the fixture quote is itself
      // a substring of the captured Apify caption, so this closes the chain to the real Reel.
      expect(out).toContain(`"${stop.evidence_json.quote}"`)
    })

    it('answers the second typed stop with research and no Reel line', async () => {
      /* The contrast, and the product's whole argument: a suggestion is not dressed up as
         evidence. If pin 4 ever became a reel-quoted stop the beat would collapse into "two
         stops with Reels", so the kind is asserted against the one the script names. */
      const [pinText, name, kind] = SCRIPT_SUGGESTED!.slice(1)
      const pin = Number(pinText)
      expect(pin).toBe(SCRIPT_STOP_PROMPTS[1])
      const stop = stopAtPin(pin)
      expect(stop.place.name).toBe(name)
      expect(stop.evidence_json.evidence_kind).toBe(kind)

      mountSampleTrail()
      await waitFor(() => { expect(names()).toHaveLength(6) })
      const out = await callTool('get_place_evidence', { place: String(pin) })
      expect(out).toMatch(new RegExp(`^${pin} ${esc(name)}`))
      // Its reasoning, and an independent venue page under its own label.
      expect(stop.evidence_json.rationale, 'a suggested stop owes a reason').toBeTruthy()
      expect(out).toContain(stop.evidence_json.rationale)
      expect(out).toMatch(/^research: https?:\/\/\S+$/m)
      // No Reel, claimed or implied — not a `reel:` line, and no Instagram URL anywhere in it.
      expect(out).not.toMatch(/^reel:/m)
      expect(out).not.toContain('instagram.com')
    })
  })

  describe('1:35 — the agent drives the map', () => {
    it('registers both map tools and annotates them as writes', async () => {
      // A camera flying across a globe is not a read. `readOnlyHint` means "safe to call
      // speculatively, unnoticed", and the whole beat is the user noticing.
      mountSampleTrail()
      await waitFor(() => { expect(names()).toHaveLength(6) })
      for (const name of ['show_on_map', 'set_map_mode']) {
        expect(offered(name).annotations?.readOnlyHint, `${name} moves the map`).toBe(false)
      }
    })

    it('shows the day the script asks for, with that day\'s stops', async () => {
      mountSampleTrail()
      await waitFor(() => { expect(names()).toHaveLength(6) })
      const out = await callTool('show_on_map', { target: 'day', day: SCRIPT_MAP_DAY })
      const stops = placesForDay(TOKYO_TRIP, SCRIPT_MAP_DAY)
      expect(stops.length, `day ${SCRIPT_MAP_DAY} must have stops to fly to`).toBeGreaterThan(0)
      expect(out).toContain(`Showing day ${SCRIPT_MAP_DAY}`)
      for (const stop of stops) expect(out).toContain(stop.place.name)
    })
  })

  describe('2:35 — how it is built', () => {
    it('mounts the number of tools the script claims, in two scopes', async () => {
      signIn()
      mountSampleTrail()
      await waitFor(() => { expect(names().length).toBe(SCRIPT_TOTAL_TOOLS) })
    })

    it('keeps the trip scope separate — it is what leaves when the page does', async () => {
      /* "trip tools register when a trip opens and unregister when you navigate away — which is
         the tool count you watched change." Mounting the trip half alone is what that count
         changes BY. No session is set up because none is read: these three are pure in-page
         state, which is why the sample trail can offer them with no account. */
      mountTripScopeOnly()
      await waitFor(() => { expect(names().length).toBeGreaterThan(0) })
      expect([...names()].sort()).toEqual(['get_map_view', 'set_map_mode', 'show_on_map'])
      expect(names().length).toBeLessThan(SCRIPT_TOTAL_TOOLS!)
    })

    it('flags every tool that actually hands an Instagram caption to the agent', async () => {
      /* The script: "Every tool that can return an Instagram caption is annotated
         untrustedContentHint". `spec-contract.test.ts` audits that on the SPECS with a canary
         trip; what is unproven there, and is what a judge inspects, is that the annotation
         survives registration — `useRegisterTool` rebuilds the payload field by field, so a
         dropped line there leaves the specs correct and the browser unwarned. */
      mountSampleTrail()
      await waitFor(() => { expect(names()).toHaveLength(6) })
      // Text that exists only because somebody wrote it in an Instagram caption.
      const captionText = [
        ...TOKYO_TRIP.places.map((tp) => tp.place.name),
        ...TOKYO_TRIP.places.map((tp) => tp.evidence_json.quote).filter((q): q is string => !!q),
      ]
      const probes: Record<string, Record<string, unknown>> = {
        get_app_state: {},
        get_itinerary: {},
        get_place_evidence: { place: String(SCRIPT_STOP_PROMPTS[0]) },
        get_map_view: {},
        set_map_mode: { mode: 'route' },
        show_on_map: { target: 'day', day: SCRIPT_MAP_DAY },
      }
      expect(Object.keys(probes).sort()).toEqual([...names()].sort())

      const echoed: string[] = []
      for (const [name, args] of Object.entries(probes)) {
        const out = await callTool(name, args)
        if (captionText.some((t) => out.includes(t))) echoed.push(name)
      }
      // At least one must, or the probe proved nothing about a hint.
      expect(echoed.length).toBeGreaterThan(0)
      for (const name of echoed) {
        expect(
          offered(name).annotations?.untrustedContentHint,
          `${name} handed caption text back unflagged`,
        ).toBe(true)
      }
    })

    it('addresses stops by pin number, and gives no tool a UUID to take', async () => {
      /* "Stops are addressed by map-pin number, never by UUID, so the agent's vocabulary is the
         same as the user's." Asserted over every registered schema, so a new tool cannot ship a
         `place_id` and leave this claim quietly false. */
      signIn()
      mountSampleTrail()
      await waitFor(() => { expect(names()).toHaveLength(16) })
      for (const tool of registered) {
        for (const [key, prop] of Object.entries(tool.inputSchema?.properties ?? {})) {
          expect(key, `${tool.name}.${key} takes a place id`).not.toMatch(/place_?id|^id$/i)
          expect(prop.description ?? '', `${tool.name}.${key} asks for a uuid`).not.toMatch(/uuid/i)
          if (key === 'place') {
            expect(prop.description, `${tool.name}.place must ask for a pin`).toMatch(/pin number/i)
          }
        }
      }
    })

    it('refuses a raw stop id, because that is not the address space', async () => {
      // The other half of the same claim, behaviourally: hand the tool the row id the database
      // uses and it does not resolve. Pin numbers are the vocabulary, not a convenience alias.
      mountSampleTrail()
      await waitFor(() => { expect(names()).toHaveLength(6) })
      const stop = stopAtPin(SCRIPT_STOP_PROMPTS[1])
      const out = await callTool('get_place_evidence', { place: stop.id })
      expect(out).toContain('No stop matches')
      expect(out).not.toContain(stop.place.name)
    })
  })
})
