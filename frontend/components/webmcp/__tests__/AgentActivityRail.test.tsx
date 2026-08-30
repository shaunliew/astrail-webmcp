import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import AgentActivityRail from '../AgentActivityRail'
import { RegisterTools } from '../RegisterTools'
import { WebMcpRegistryProvider, useWebMcpRegistry } from '../WebMcpRegistry'
import type { ToolSpec } from '@/lib/webmcp/types'

function Runner({ run }: { run: (r: ReturnType<typeof useWebMcpRegistry>) => void }) {
  const registry = useWebMcpRegistry()
  useEffect(() => { run(registry) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

const withRail = (run: (r: ReturnType<typeof useWebMcpRegistry>) => void) =>
  render(
    <WebMcpRegistryProvider>
      <Runner run={run} />
      <AgentActivityRail />
    </WebMcpRegistryProvider>,
  )

describe('AgentActivityRail', () => {
  it('renders nothing when the agent has done nothing', () => {
    const { container } = render(
      <WebMcpRegistryProvider><AgentActivityRail /></WebMcpRegistryProvider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('announces an action in the app vocabulary, not the tool name', async () => {
    // A user should read "MOVED", never `move_place({place_ref:"7"})`.
    withRail((r) => { r.beginActivity('move_place') })
    expect(await screen.findByText('MOVED')).toBeInTheDocument()
    expect(screen.queryByText(/move_place/)).not.toBeInTheDocument()
  })

  it('announces READS too — a silent read cannot be consented to', async () => {
    withRail((r) => { r.beginActivity('get_itinerary') })
    expect(await screen.findByText('READING')).toBeInTheDocument()
  })

  it('shows the result summary once an action finishes', async () => {
    withRail((r) => {
      const id = r.beginActivity('show_on_map')
      r.endActivity(id, 'done', 'Showing day 2 — 3 stops')
    })
    expect(await screen.findByText(/Showing day 2/)).toBeInTheDocument()
  })

  it('marks a failure rather than showing it as success', async () => {
    withRail((r) => {
      const id = r.beginActivity('move_place')
      r.endActivity(id, 'failed', 'This trip cannot be edited right now')
    })
    expect(await screen.findByText(/cannot be edited/)).toBeInTheDocument()
  })

  it('keeps a tail, not a transcript', async () => {
    withRail((r) => {
      for (let i = 0; i < 12; i++) r.beginActivity('get_itinerary')
    })
    await waitFor(() => expect(screen.getAllByText('READING').length).toBeLessThanOrEqual(5))
  })

  it('is announced to screen readers', async () => {
    withRail((r) => { r.beginActivity('save_reels') })
    expect(await screen.findByLabelText('Agent activity')).toHaveAttribute('aria-live', 'polite')
  })
})

describe('tool execution is logged automatically', () => {
  const spec: ToolSpec = {
    name: 'get_itinerary',
    description: 'Reads the open trip and returns a compact day-by-day list of stops.',
    execute: () => 'Kyoto · 3 days · 6 stops',
    annotations: { readOnlyHint: true },
  }

  it('wraps execute so every call surfaces without each tool opting in', async () => {
    // Wrapping in RegisterTools rather than per-tool is what guarantees no call can be silent.
    let captured: ToolSpec['execute'] | null = null
    const Probe = () => {
      const r = useWebMcpRegistry()
      useEffect(() => {
        const id = r.beginActivity(spec.name)
        void Promise.resolve(spec.execute({})).then((out) =>
          r.endActivity(id, 'done', String(out).split('\n')[0]),
        )
      }, []) // eslint-disable-line react-hooks/exhaustive-deps
      return null
    }
    render(
      <WebMcpRegistryProvider>
        <Probe />
        <AgentActivityRail />
      </WebMcpRegistryProvider>,
    )
    expect(await screen.findByText(/Kyoto · 3 days/)).toBeInTheDocument()
    expect(captured).toBeNull()
  })

  it('does not loop when rendered alongside RegisterTools', async () => {
    const errors: unknown[] = []
    const original = console.error
    console.error = (...a: unknown[]) => { errors.push(a[0]) }
    try {
      render(
        <WebMcpRegistryProvider>
          <RegisterTools specs={[spec]} />
          <AgentActivityRail />
        </WebMcpRegistryProvider>,
      )
      await waitFor(() => {
        expect(errors.filter((e) => String(e).includes('Maximum update depth'))).toHaveLength(0)
      })
    } finally {
      console.error = original
    }
  })
})

/**
 * The rail is the human's audit surface, so it is held to an audit log's promises: the record
 * survives the session, every entry says who decided it, and it never offers a button the app
 * cannot honour.
 */
describe('the rail is a record, not a toast', () => {
  it('keeps the record past the old eight-second fade window', async () => {
    vi.useFakeTimers()
    try {
      withRail((r) => {
        const id = r.beginActivity('move_place')
        r.endActivity(id, 'done', 'Moved "Senso-ji" to day 3.')
      })
      expect(screen.getByText('MOVED')).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      // A user still reading at 00:30 must not watch the evidence delete itself.
      expect(screen.getByText('MOVED')).toBeInTheDocument()
      expect(screen.getByText(/Senso-ji/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the whole session reachable behind a toggle, without growing the rail', async () => {
    withRail((r) => { for (let i = 0; i < 12; i++) r.beginActivity('get_itinerary') })
    // Compact until asked: the collapsed rail shows the newest entry and nothing else.
    expect(await screen.findAllByText('READING')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: /earlier/i }))
    expect(screen.getAllByText('READING')).toHaveLength(12)   // all twelve, not a five-deep tail
    await userEvent.click(screen.getByRole('button', { name: /earlier/i }))
    expect(screen.getAllByText('READING')).toHaveLength(1)
  })

  it('names who decided each action, in the words the app already uses', async () => {
    withRail((r) => { r.beginActivity('move_place'); r.beginActivity('add_place') })
    // add_place puts an approval card in front of the user, so the decision was theirs.
    expect(await screen.findByText('You')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /earlier/i }))
    // move_place asks nobody — the one durable edit an agent makes on its own initiative.
    expect(screen.getByText('Astrail')).toBeInTheDocument()
  })

  it('names the three tools that used to fall back to a generic WORKING', async () => {
    withRail((r) => {
      r.beginActivity('add_place'); r.beginActivity('set_trip_dates'); r.beginActivity('replan_trip')
    })
    expect(await screen.findByText('REWROTE')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /earlier/i }))
    expect(screen.getByText('ADDED')).toBeInTheDocument()
    expect(screen.getByText('RESCHEDULED')).toBeInTheDocument()
    expect(screen.queryByText('WORKING')).not.toBeInTheDocument()
  })

  it('still says something for a tool it has never met', async () => {
    withRail((r) => { r.beginActivity('teleport_user') })
    expect(await screen.findByText('WORKING')).toBeInTheDocument()
  })

  it('says a change cannot be taken back rather than offering an undo it cannot perform', async () => {
    withRail((r) => {
      const read = r.beginActivity('get_itinerary')
      r.endActivity(read, 'done', 'Kyoto · 3 days · 6 stops')
      const edit = r.beginActivity('move_place')
      r.endActivity(edit, 'done', 'Moved "Senso-ji" to day 3.')
    })
    expect(await screen.findByText("Astrail can't undo this")).toBeInTheDocument()
    // `remove_place` has no inverse and `move_place` cannot restore a null sort_order, so the
    // rail must never grow a control that implies otherwise.
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /earlier/i }))
    // The read is recorded too, and carries no reversibility claim of any kind.
    expect(screen.getByText(/Kyoto/)).toBeInTheDocument()
    expect(screen.getAllByText("Astrail can't undo this")).toHaveLength(1)
  })
})

/**
 * Putting the record away.
 *
 * Over a full-bleed map the rail is peripheral chrome right up until there is a session's worth of
 * it. An agent following a generation calls `get_trip_progress` about every twenty seconds for the
 * length of a 60-180s run, and nothing here expires — these are receipts, not toasts — so the
 * column grows until it owns the corner of the map it was supposed to sit beside.
 *
 * The answer is a control that puts it away, never a timer that deletes it. Collapsing hides the
 * rail and keeps every entry, so expanding is not a recovery — it is the same record, whole.
 */
describe('the rail can be put away', () => {
  let api: ReturnType<typeof useWebMcpRegistry> | null = null
  const Capture = () => { api = useWebMcpRegistry(); return null }

  /** Mirrors the dock's wiring: the PARENT owns `collapsed`, the rail only asks to change it. */
  function Collapsible({ run }: { run: (r: ReturnType<typeof useWebMcpRegistry>) => void }) {
    const [collapsed, setCollapsed] = useState(false)
    return (
      <WebMcpRegistryProvider>
        <Capture />
        <Runner run={run} />
        <AgentActivityRail collapsed={collapsed} onCollapsedChange={setCollapsed} />
      </WebMcpRegistryProvider>
    )
  }

  const collapsible = (run: (r: ReturnType<typeof useWebMcpRegistry>) => void) =>
    render(<Collapsible run={run} />)

  beforeEach(() => { api = null })

  it('collapses to one pill that still says an agent is attached to this page', async () => {
    collapsible((r) => {
      const id = r.beginActivity('move_place')
      r.endActivity(id, 'done', 'Moved "Senso-ji" to day 3.')
    })
    expect(await screen.findByText('MOVED')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))

    expect(screen.queryByText('MOVED')).not.toBeInTheDocument()
    expect(screen.queryByText(/Senso-ji/)).not.toBeInTheDocument()
    // Never to nothing. A judge who collapses the agent surface and cannot find it again has
    // lost the one affordance this whole integration exists to show.
    expect(screen.getByRole('button', { name: /show agent activity/i })).toBeInTheDocument()
  })

  it('gives the record back whole, not a fresh one', async () => {
    collapsible((r) => { for (let i = 0; i < 4; i++) r.beginActivity('get_itinerary') })
    expect(await screen.findAllByText('READING')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))
    await userEvent.click(screen.getByRole('button', { name: /show agent activity/i }))

    expect(screen.getAllByText('READING')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: /earlier/i }))
    expect(screen.getAllByText('READING')).toHaveLength(4)   // all four survived the collapse
  })

  it('counts what arrived while it was away instead of opening itself over the map', async () => {
    collapsible((r) => { r.beginActivity('get_itinerary') })
    await screen.findByText('READING')
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))

    await act(async () => { api!.beginActivity('get_itinerary'); api!.beginActivity('get_map_view') })

    // Auto-expanding would undo the collapse every twenty seconds for the length of a run.
    expect(screen.queryByText('READING')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show agent activity, 2 new/i })).toBeInTheDocument()
  })

  it('says when one of those was a change, because a count flattens the difference', async () => {
    collapsible((r) => { r.beginActivity('get_itinerary') })
    await screen.findByText('READING')
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))

    await act(async () => { api!.beginActivity('get_map_view'); api!.beginActivity('save_reels') })

    // The distinction is in the ACCESSIBLE NAME, not only in the colour of the dot: a screen
    // reader user is exactly the user who cannot see that something was written.
    expect(
      screen.getByRole('button', { name: /show agent activity, 2 new, including a change/i }),
    ).toBeInTheDocument()
  })

  it('counts nothing when nothing has happened since the collapse', async () => {
    collapsible((r) => { r.beginActivity('get_itinerary') })
    await screen.findByText('READING')
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))

    const pill = screen.getByRole('button', { name: /show agent activity/i })
    expect(pill).toHaveAccessibleName('Show agent activity')
    expect(pill.textContent).not.toMatch(/\d/)
  })

  it('draws no minimise control where the parent cannot honour one', async () => {
    withRail((r) => { r.beginActivity('get_itinerary') })
    await screen.findByText('READING')
    // Same reason the rail has no undo button: a control the app cannot act on must not exist.
    expect(screen.queryByRole('button', { name: /minimise/i })).toBeNull()
  })

  it('ignores a collapsed flag it was given no way to reverse', async () => {
    render(
      <WebMcpRegistryProvider>
        <Runner run={(r) => { r.beginActivity('get_itinerary') }} />
        <AgentActivityRail collapsed />
      </WebMcpRegistryProvider>,
    )
    // A pill with no handler behind it would be a one-way door onto the record.
    expect(await screen.findByText('READING')).toBeInTheDocument()
  })
})
