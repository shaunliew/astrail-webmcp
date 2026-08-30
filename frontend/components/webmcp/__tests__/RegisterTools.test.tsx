import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { RegisterTools } from '../RegisterTools'
import { WebMcpRegistryProvider } from '../WebMcpRegistry'
import AgentActivityRail, { NOTHING_CLEARED, type ClearedMark } from '../AgentActivityRail'
import WebMcpStatus from '../WebMcpStatus'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { movePlaceTool, removePlaceTool, type EditDeps } from '@/lib/webmcp/tools/edit'
import type { ToolSpec } from '@/lib/webmcp/types'

const spec = (name: string): ToolSpec => ({
  name,
  description: `A tool called ${name} that does something for the agent.`,
  execute: () => 'ok',
  annotations: { readOnlyHint: true },
})

describe('RegisterTools inside the real provider', () => {
  it('settles instead of re-rendering forever', async () => {
    // Regression, found only in a real browser: the effect depended on the whole context value,
    // which is memoized on `tools` — so report() -> new tools -> new context -> effect -> report()
    // looped until React threw "Maximum update depth exceeded". Every earlier unit test seeded
    // the registry directly and never rendered RegisterTools inside the provider, so all of them
    // passed while the trip page was unusable.
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args[0]) }
    try {
      render(
        <WebMcpRegistryProvider>
          <RegisterTools specs={[spec('tool_one'), spec('tool_two')]} />
          <WebMcpStatus open={false} onOpenChange={() => {}} />
        </WebMcpRegistryProvider>,
      )
      await waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument())
      const depthErrors = errors.filter((e) => String(e).includes('Maximum update depth'))
      expect(depthErrors).toHaveLength(0)
    } finally {
      console.error = original
    }
  })

  it('lists each registered tool exactly once', async () => {
    render(
      <WebMcpRegistryProvider>
        <RegisterTools specs={[spec('tool_one'), spec('tool_two')]} />
        <WebMcpStatus open={false} onOpenChange={() => {}} />
      </WebMcpRegistryProvider>,
    )
    // No WebMCP in jsdom, so the chip reports unavailable — but the registration path still ran
    // without looping, which is what this file exists to prove.
    await userEvent.click(await screen.findByRole('button'))
    expect(screen.getByText(/WebMCP unavailable/)).toBeInTheDocument()
  })

  it('handles a spec list that changes identity every render', async () => {
    // GlobalTools rebuilds its specs array on each render; that must not cause churn either.
    function Churny() {
      return <RegisterTools specs={[spec('tool_one')]} />
    }
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args[0]) }
    try {
      const { rerender } = render(
        <WebMcpRegistryProvider><Churny /></WebMcpRegistryProvider>,
      )
      for (let i = 0; i < 5; i++) {
        rerender(<WebMcpRegistryProvider><Churny /></WebMcpRegistryProvider>)
      }
      await waitFor(() => {
        expect(errors.filter((e) => String(e).includes('Maximum update depth'))).toHaveLength(0)
      })
    } finally {
      console.error = original
    }
  })
})

/**
 * The record has to say what HAPPENED, not that the call came back.
 *
 * Every mutating tool has endings that are not changes — the user declines the approval card, the
 * backend refuses — and all of them return an ordinary string rather than throwing. The wrapper
 * treated "did not throw" as success, so the rail wrote `REMOVED · You · done` with "Astrail
 * can't undo this" underneath, permanently, for a removal the user had just refused with the stop
 * still on the map beside it. A durable record asserting the opposite of what occurred, on the
 * surface this integration advertises as its accountability layer.
 *
 * Driven through `document.modelContext` with the REAL edit tools, because the wrapper is the
 * thing under test: calling a spec directly would prove nothing about what the browser reaches,
 * and asserting on an internal status flag would prove nothing about what a person reads.
 */
describe('an entry says how the call ended', () => {
  const registered: { name: string; execute: (a: Record<string, unknown>) => Promise<unknown> }[] = []

  const deps = (over: Partial<EditDeps> = {}): EditDeps => ({
    trips: { current: () => TOKYO_TRIP, list: async () => [TOKYO_TRIP.trip], load: async () => TOKYO_TRIP },
    add: vi.fn().mockResolvedValue({}),
    setDates: vi.fn().mockResolvedValue({}),
    replan: vi.fn().mockResolvedValue({ days_narrated: 1, routes_refreshed: true }),
    move: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue(TOKYO_TRIP),
    confirm: vi.fn().mockResolvedValue(true),
    ...over,
  })

  /** The rail plus the state the dock holds for it in the app. */
  function Rail() {
    const [cleared, setCleared] = useState<ClearedMark>(NOTHING_CLEARED)
    return <AgentActivityRail cleared={cleared} onClear={setCleared} />
  }

  /** Mounts the tools the way the browser does, then calls one the way an agent would. */
  async function callThroughBrowser(spec: ToolSpec, args: Record<string, unknown>) {
    render(
      <WebMcpRegistryProvider>
        <RegisterTools specs={[spec]} />
        <Rail />
      </WebMcpRegistryProvider>,
    )
    await waitFor(() => { expect(registered.map((t) => t.name)).toContain(spec.name) })
    await act(async () => { await registered.find((t) => t.name === spec.name)!.execute(args) })
  }

  beforeEach(() => {
    registered.length = 0
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool: (tool: (typeof registered)[number]) => { registered.push(tool) } },
    })
  })

  afterEach(() => { Reflect.deleteProperty(document, 'modelContext') })

  it('does not record a declined removal as a removal', async () => {
    const stop = TOKYO_TRIP.places[0].place.name
    await callThroughBrowser(removePlaceTool(deps({ confirm: vi.fn().mockResolvedValue(false) })), { place: '1' })

    // What a person reads: the attempt, refused. Not the past tense, and not the line that says
    // the app cannot take it back — there is nothing to take back.
    expect(screen.getByText('REMOVE DECLINED')).toBeInTheDocument()
    expect(screen.queryByText('REMOVED')).toBeNull()
    expect(screen.queryByText(/can't undo this/)).toBeNull()
    // The stop is still on the trip, and the receipt says so in the app's own words.
    expect(screen.getByText(new RegExp(`declined.*${stop}.*still on the trip`, 'i'))).toBeInTheDocument()
  })

  it('does not record a failed move as a move', async () => {
    await callThroughBrowser(
      movePlaceTool(deps({ move: vi.fn().mockRejectedValue(new Error('This trip cannot be edited right now.')) })),
      { place: '1', to_day: 3 },
    )

    expect(screen.getByText('MOVE FAILED')).toBeInTheDocument()
    expect(screen.queryByText('MOVED')).toBeNull()
    expect(screen.queryByText(/can't undo this/)).toBeNull()
    expect(screen.getByText(/cannot be edited right now/)).toBeInTheDocument()
  })

  it('does not record a move the tool never attempted as a move', async () => {
    // The bail-outs are the same lie with no approval card and no backend in it: a `move_place`
    // handed neither a day nor a position moved nothing, and the rail said MOVED.
    await callThroughBrowser(movePlaceTool(deps()), { place: '1' })

    expect(screen.getByText('MOVE FAILED')).toBeInTheDocument()
    expect(screen.queryByText('MOVED')).toBeNull()
    expect(screen.queryByText(/can't undo this/)).toBeNull()
  })

  it('still records a move that DID happen as one, warning included', async () => {
    // The other direction matters as much: a rail that stopped claiming anything would be honest
    // and useless. `move_place` is the one durable edit made with no approval card at all.
    await callThroughBrowser(movePlaceTool(deps()), { place: '1', to_day: 3 })

    expect(screen.getByText('MOVED')).toBeInTheDocument()
    expect(screen.getByText("Astrail can't undo this")).toBeInTheDocument()
    // And the receipt reads as a sentence, not as the raw envelope the tool answers in.
    expect(screen.getByText(/^Moved /)).toBeInTheDocument()
    expect(screen.queryByText(/summaries_stale/)).toBeNull()
  })

  it('records a tool that says nothing about its outcome exactly as it always did', async () => {
    // Most tools answer in prose and declare no outcome. Absence is not evidence of failure, and
    // treating it as one would put a red FAILED on every read in the app.
    const read: ToolSpec = {
      name: 'get_itinerary',
      description: 'Reads the open trip and returns a compact day-by-day list of stops.',
      execute: () => 'Kyoto · 3 days · 6 stops',
      annotations: { readOnlyHint: true },
    }
    await callThroughBrowser(read, {})

    expect(screen.getByText('READING')).toBeInTheDocument()
    expect(screen.getByText(/Kyoto · 3 days/)).toBeInTheDocument()
  })
})
