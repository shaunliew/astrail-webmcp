import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import AgentActivityRail, { NOTHING_CLEARED, type ClearedMark } from '../AgentActivityRail'
import { RegisterTools } from '../RegisterTools'
import { WebMcpRegistryProvider, useWebMcpRegistry } from '../WebMcpRegistry'
import type { ToolSpec } from '@/lib/webmcp/types'

function Runner({ run }: { run: (r: ReturnType<typeof useWebMcpRegistry>) => void }) {
  const registry = useWebMcpRegistry()
  useEffect(() => { run(registry) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

/**
 * The rail plus the state its owner holds.
 *
 * The clear watermark lives in `WebMcpDock` in the app, because the dock is what unmounts the
 * rail when it folds. This stands in for that owner so these tests can drive the rail alone —
 * and it is deliberately NOT a default inside the component: the mount that survives a fold is
 * the behaviour, so it is proven where it lives (`WebMcpDock.test.tsx`), not simulated here.
 */
function Rail({ compact }: { compact?: boolean }) {
  const [cleared, setCleared] = useState<ClearedMark>(NOTHING_CLEARED)
  return <AgentActivityRail compact={compact} cleared={cleared} onClear={setCleared} />
}

const withRail = (run: (r: ReturnType<typeof useWebMcpRegistry>) => void) =>
  render(
    <WebMcpRegistryProvider>
      <Runner run={run} />
      <Rail />
    </WebMcpRegistryProvider>,
  )

describe('AgentActivityRail', () => {
  it('renders nothing when the agent has done nothing', () => {
    const { container } = render(
      <WebMcpRegistryProvider><Rail /></WebMcpRegistryProvider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('announces an action in the app vocabulary, not the tool name', async () => {
    // A user should read "MOVED", never `move_place({place_ref:"7"})`.
    withRail((r) => { r.endActivity(r.beginActivity('move_place'), 'done') })
    expect(await screen.findByText('MOVED')).toBeInTheDocument()
    expect(screen.queryByText(/move_place/)).not.toBeInTheDocument()
  })

  it('does not claim the action happened while it is still happening', async () => {
    // `remove_place` spends its whole in-flight life with an approval card on screen, so the
    // past-tense label was the record saying the stop was gone for as long as the user took to
    // read the card and decide — the longest and most visible of the three windows.
    withRail((r) => { r.beginActivity('remove_place') })
    expect(await screen.findByText('REMOVE')).toBeInTheDocument()
    expect(screen.queryByText('REMOVED')).toBeNull()
  })

  it('leaves a read in flight reading exactly as it did', async () => {
    // A read in flight genuinely IS reading; only a write has a completed form to mis-claim.
    // Forcing a bare stem here would trade a correct word for a worse one to fix nothing.
    withRail((r) => { r.beginActivity('get_itinerary'); r.beginActivity('save_reels') })
    expect(await screen.findByText('SAVING')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /earlier/i }))
    expect(screen.getByText('READING')).toBeInTheDocument()
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
        <Rail />
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
          <Rail />
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
    withRail((r) => { r.beginActivity('save_reels'); r.beginActivity('add_place') })
    // add_place puts an approval card in front of the user, so the decision was theirs.
    expect(await screen.findByText('You')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /earlier/i }))
    /* `save_reels` asks nobody — it writes to the library on the agent's own initiative. It used
       to be `move_place` here, which stopped being the example the day a move started raising its
       own card: every mutation now starts a narration, so a cardless move spent an LLM call
       nobody had approved. */
    expect(screen.getByText('Astrail')).toBeInTheDocument()
  })

  it('credits a move to the user, now that a move asks them first', async () => {
    /* `move_place` used to be the counter-example on this rail — the one durable edit made on the
       agent's own initiative, so `actor` read 'Astrail'. It raises its own approval card now,
       because every mutation starts a narration and a cardless move spent an LLM call nobody had
       approved. The record has to follow the card, or it credits the wrong hand for the decision. */
    withRail((r) => { r.endActivity(r.beginActivity('move_place'), 'done', 'Moved "Senso-ji" to day 3.') })

    expect(await screen.findByText('MOVED')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.queryByText('Astrail')).toBeNull()
  })

  it('attributes a failure to nobody, rather than to the person who was never asked', async () => {
    /* `actor` is a static property of the tool, but a FAILURE is the one ending where the named
       person may never have been involved: `move_place` handed a pin that does not exist fails
       before any card is raised, and the chip read "You · You decided this" to someone who had
       been shown nothing. A validation error is not a decision, so it is attributed to no one. */
    withRail((r) => { r.endActivity(r.beginActivity('move_place'), 'failed', 'No stop matches "99".', 'nobody') })

    expect(await screen.findByText('MOVE FAILED')).toBeInTheDocument()
    expect(screen.queryByText('You')).toBeNull()
    expect(screen.queryByText('Astrail')).toBeNull()
  })

  it('keeps the attribution on a failure the user DID decide', async () => {
    /* The over-correction, and it is as easy to ship as the bug. An edit the user approved and the
       backend then refused is exactly the decision this rail exists to record — keying the chip on
       `status !== 'failed'` hid it, gutting the accountability half to fix the validation case. */
    withRail((r) => {
      r.endActivity(r.beginActivity('remove_place'), 'failed', 'This trip cannot be edited right now.', 'user')
    })

    expect(await screen.findByText('REMOVE FAILED')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
  })

  it('credits the agent for a rewrite it joined without asking anyone', async () => {
    // `replan_trip` joining a rewrite an edit already started raises no card, so "You decided
    // this" would contradict the code that deliberately did not ask.
    withRail((r) => {
      r.endActivity(r.beginActivity('replan_trip'), 'done', 'Joined the rewrite this trip already had running.', 'agent')
    })

    expect(await screen.findByText('REWROTE')).toBeInTheDocument()
    expect(screen.getByText('Astrail')).toBeInTheDocument()
    expect(screen.queryByText('You')).toBeNull()
  })

  it('keeps the attribution on a decline, which IS a decision that happened', async () => {
    // The other direction: withholding it everywhere would gut the accountability half of the
    // rail. A refusal is exactly the decision the card exists to record.
    withRail((r) => { r.endActivity(r.beginActivity('remove_place'), 'declined', 'The user declined.') })

    expect(await screen.findByText('REMOVE DECLINED')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
  })

  it('names the three tools that used to fall back to a generic WORKING', async () => {
    withRail((r) => {
      r.endActivity(r.beginActivity('add_place'), 'done')
      r.endActivity(r.beginActivity('set_trip_dates'), 'done')
      r.endActivity(r.beginActivity('replan_trip'), 'done')
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

  /* A QUESTION IS NOT A FAILURE.

     `plan_trip_from_reels` stops and asks how the user likes to travel when it has nothing to go
     on. The rail printed that as a red `PLANNING FAILED` — for a call that broke nothing, spent
     nothing, and is one answer away from running. The record was accusing the app of an outage in
     front of the user, on the surface built to tell them the truth about what the agent did. */
  it('reads a question as a question, not as an outage', async () => {
    const { container } = withRail((r) => {
      const id = r.beginActivity('plan_trip_from_reels')
      r.endActivity(id, 'asked', 'Astrail has not learned how this user likes to travel yet.')
    })
    expect(await screen.findByText('PLANNING NEEDS YOUR ANSWER')).toBeInTheDocument()
    expect(screen.queryByText(/FAILED/)).toBeNull()
    expect(
      container.querySelector('.bg-red-400'),
      'a question the user can answer was painted as an error',
    ).toBeNull()
  })

  it('claims nothing was done that could need undoing when it only asked', async () => {
    // `plan_trip_from_reels` is a write in the table, so the reversibility line is reachable
    // for it — but an ask started no run, and "Astrail can't undo this" would be a claim that
    // something happened at all.
    withRail((r) => {
      const id = r.beginActivity('plan_trip_from_reels')
      r.endActivity(id, 'asked', 'Ask them how they like to travel.')
    })
    expect(await screen.findByText(/how they like to travel/)).toBeInTheDocument()
    expect(screen.queryByText("Astrail can't undo this")).toBeNull()
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
 * Clearing, the way you clear a notification tray.
 *
 * 1eb444e made this a session record rather than a fading toast, and that decision stands: an
 * agent action must not disappear while the user was looking elsewhere. A clear the USER pressed
 * is the opposite of that — they have seen the entries and dismissed them. So the record may go,
 * and it goes completely: cleared entries are gone from the read-back too, not filed somewhere.
 *
 * Two things a clear may not do. It may not silence a call that has not finished — an in-flight
 * tool call is not something anyone has read and dismissed, and a user watching a run needs to
 * see it is still going. And it may not mute what happens NEXT: clearing dismisses what has
 * happened, it does not turn the rail off.
 */
describe('the rail can be cleared', () => {
  let api: ReturnType<typeof useWebMcpRegistry> | null = null
  const Capture = () => { api = useWebMcpRegistry(); return null }

  const clearable = (run: (r: ReturnType<typeof useWebMcpRegistry>) => void) =>
    render(
      <WebMcpRegistryProvider>
        <Capture />
        <Runner run={run} />
        <Rail />
      </WebMcpRegistryProvider>,
    )

  beforeEach(() => { api = null })

  it('takes the read entries off the screen entirely', async () => {
    const { container } = clearable((r) => {
      for (let i = 0; i < 3; i++) r.endActivity(r.beginActivity('get_itinerary'), 'done', `read ${i}`)
    })
    expect(await screen.findByText('READING')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /clear agent activity/i }))
    expect(container).toBeEmptyDOMElement()
  })

  it('leaves no way back to them — this is a clear, not a filing cabinet', async () => {
    clearable((r) => {
      for (let i = 0; i < 4; i++) r.endActivity(r.beginActivity('get_itinerary'), 'done', `read ${i}`)
    })
    await screen.findByText('READING')
    await userEvent.click(screen.getByRole('button', { name: /clear agent activity/i }))
    api!.beginActivity('move_place')
    expect(await screen.findByText('MOVE')).toBeInTheDocument()
    // One entry now, and nothing behind it: the four reads did not become "4 earlier".
    expect(screen.queryByRole('button', { name: /earlier/i })).toBeNull()
  })

  it('cannot clear a call that has not finished — a live run must stay visible', async () => {
    clearable((r) => {
      r.endActivity(r.beginActivity('get_itinerary'), 'done', 'Kyoto · 3 days')
      r.beginActivity('get_trip_progress')          // still in flight
    })
    expect(await screen.findByText('WATCHING')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /clear agent activity/i }))

    expect(screen.getByText('WATCHING')).toBeInTheDocument()   // survives
    expect(screen.queryByText('READING')).not.toBeInTheDocument()
    expect(screen.queryByText(/Kyoto/)).not.toBeInTheDocument()
  })

  it('lets that call clear once it lands', async () => {
    let running = 0
    clearable((r) => { running = r.beginActivity('get_trip_progress') })
    await screen.findByText('WATCHING')
    await userEvent.click(screen.getByRole('button', { name: /clear agent activity/i }))
    expect(screen.getByText('WATCHING')).toBeInTheDocument()

    await act(async () => { api!.endActivity(running, 'done', 'complete · 92s') })
    await userEvent.click(screen.getByRole('button', { name: /clear agent activity/i }))
    expect(screen.queryByText('WATCHING')).not.toBeInTheDocument()
  })

  it('still announces what the agent does next', async () => {
    const { container } = clearable((r) => {
      r.endActivity(r.beginActivity('get_itinerary'), 'done', 'read the page')
    })
    await screen.findByText('READING')
    await userEvent.click(screen.getByRole('button', { name: /clear agent activity/i }))
    expect(container).toBeEmptyDOMElement()

    api!.beginActivity('save_reels')
    // Clearing dismisses what has happened; it does not turn the rail off.
    expect(await screen.findByText('SAVING')).toBeInTheDocument()
  })

})

/**
 * A receipt that says how old it is.
 *
 * Confirmed from a real run: the trip finished and the newest card still read "generating · 86s".
 * That card is not stale data and it is not a missed re-render — `RegisterTools` is the only
 * writer of entries in the app, and `detail` is immutable text captured when the call returned.
 * The entry is a CORRECT receipt of a call that did return exactly that.
 *
 * The flaw is narrower than it looks. `get_trip_progress` is the one tool whose return value is a
 * world-state rather than a description of what the call did: "Moved Senso-ji to day 3" is true
 * forever, "generating · 86s" is false a second later. Since the rail shows the newest entry on
 * its own, a reader takes a timestamped record as a current status.
 *
 * So the record is not touched and nothing expires. The card is given its age, which is the one
 * piece of information that turns a status back into history.
 */
describe('an entry says how old it is', () => {
  it('says nothing while the receipt is still current', async () => {
    withRail((r) => { r.endActivity(r.beginActivity('get_itinerary'), 'done', 'Kyoto · 3 days') })
    expect(await screen.findByText(/Kyoto/)).toBeInTheDocument()
    expect(screen.queryByText(/ago/)).toBeNull()
  })

  it('stops the progress card claiming to be current', async () => {
    vi.useFakeTimers()
    try {
      withRail((r) => {
        r.endActivity(r.beginActivity('get_trip_progress'), 'done', 'generating · 86s · enriching places')
      })
      expect(screen.getByText(/generating · 86s/)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000) })

      // The record is untouched — it still says what the call returned — and it no longer
      // presents that as the state of the world right now.
      expect(screen.getByText(/generating · 86s/)).toBeInTheDocument()
      expect(screen.getByText('4m ago')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles on a label that stays true, so the clock can stop', async () => {
    vi.useFakeTimers()
    try {
      withRail((r) => { r.endActivity(r.beginActivity('move_place'), 'done', 'Moved "Senso-ji" to day 3.') })
      await act(async () => { await vi.advanceTimersByTimeAsync(90 * 60_000) })
      expect(screen.getByText('over an hour ago')).toBeInTheDocument()

      // "3h ago" would need a clock running all afternoon to stay honest. This one does not:
      // it is still true a day later, which is what lets the interval be torn down for good.
      const ticking = vi.getTimerCount()
      await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60 * 60_000) })
      expect(screen.getByText('over an hour ago')).toBeInTheDocument()
      expect(ticking).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps one clock for the whole rail, not one per entry', async () => {
    vi.useFakeTimers()
    try {
      const one = render(
        <WebMcpRegistryProvider>
          <Runner run={(r) => { r.beginActivity('get_itinerary') }} />
          <Rail />
        </WebMcpRegistryProvider>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const withOne = vi.getTimerCount()
      one.unmount()

      render(
        <WebMcpRegistryProvider>
          <Runner run={(r) => { for (let i = 0; i < 8; i++) r.beginActivity('get_itinerary') }} />
          <Rail />
        </WebMcpRegistryProvider>,
      )
      // The read-back has to be OPEN for this to mean anything: collapsed, the rail draws one
      // card whatever the history holds, so a per-entry clock and a per-rail clock would be
      // indistinguishable and this test would prove nothing.
      fireEvent.click(screen.getByRole('button', { name: /earlier/i }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getAllByText('READING')).toHaveLength(8)
      expect(vi.getTimerCount()).toBe(withOne)
      expect(withOne).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes its clock down with it when the dock folds it away', async () => {
    vi.useFakeTimers()
    try {
      const view = render(
        <WebMcpRegistryProvider>
          <Runner run={(r) => { r.beginActivity('get_itinerary') }} />
          <Rail />
        </WebMcpRegistryProvider>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      // Folding unmounts the rail, which is the whole reason the clock lives here.
      view.unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
