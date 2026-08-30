import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import WebMcpDock from '../WebMcpDock'
import { WebMcpRegistryProvider, useWebMcpRegistry } from '../WebMcpRegistry'

const mockPath = vi.hoisted(() => ({ value: '/app' }))
vi.mock('next/navigation', () => ({ usePathname: () => mockPath.value }))

/* Puts the dock in the state a real session reaches: an agent is present, and it has read
   something. Both are required — every panel in the dock is gated on `supported`, and the
   rail additionally renders nothing until there is an entry. */
function Session({ entries = 1 }: { entries?: number }) {
  const { setSupported, beginActivity, endActivity } = useWebMcpRegistry()
  useEffect(() => {
    setSupported(true)
    for (let i = 0; i < entries; i++) endActivity(beginActivity('get_app_state'), 'done', 'read the page')
  }, [entries, setSupported, beginActivity, endActivity])
  return null
}

const dock = (entries = 1) =>
  render(
    <WebMcpRegistryProvider>
      <Session entries={entries} />
      <WebMcpDock />
    </WebMcpRegistryProvider>,
  )

beforeEach(() => {
  mockPath.value = '/app'
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('WebMcpDock', () => {
  /* The merge finding. `/app` is a paper document with a scrolling content column; the trip
     screens are a full-bleed map. The dock is mounted once for both, so without this fork the
     same ~280px opaque panel that reads as peripheral over a map lands squarely on the /app
     content column — measured covering the capture form's Save button and a whole tray card
     (docs/webmcp/evidence/). jsdom has no layout engine, so the browser screenshots are the
     real proof; these tests hold the fork in place. */
  it('keeps the example-prompts panel off a document route', () => {
    dock()
    expect(screen.queryByText(/What can I do here\?/)).not.toBeInTheDocument()
  })

  it('still offers the example prompts over the full-bleed map', () => {
    mockPath.value = '/app/trip/abc'
    dock()
    expect(screen.getByText(/move stop 7 to day 3/)).toBeInTheDocument()
  })

  it('treats the /app/trips three-pane as canvas, not document', () => {
    // It shows the shared fixed map through a right-hand window, so an overlay belongs there.
    mockPath.value = '/app/trips'
    dock()
    expect(screen.getByText(/What can I do here\?/)).toBeInTheDocument()
  })

  it('keeps the record on a document route — nothing is discarded to buy the space', () => {
    dock()
    expect(screen.getByLabelText('Agent activity')).toBeInTheDocument()
    expect(screen.getByText('READING')).toBeInTheDocument()
  })

  it('bounds the read-back list on a document route so it cannot grow over the page', async () => {
    // 45dvh of history is fine over a map that owns the whole viewport. Over a document it is
    // three quarters of the screen. The list still holds every entry — it scrolls instead.
    dock(4)
    await userEvent.click(screen.getByLabelText('Show earlier agent activity'))
    const region = screen.getByLabelText('Earlier agent activity')
    expect(region.className).toContain('max-h-36')
    expect(region.className).toContain('overflow-y-auto')
  })

  it('lets the read-back list use the viewport over the map', async () => {
    mockPath.value = '/app/trip/abc'
    dock(4)
    await userEvent.click(screen.getByLabelText('Show earlier agent activity'))
    expect(screen.getByLabelText('Earlier agent activity').className).toContain('max-h-[45dvh]')
  })

  it('keeps the status chip on every route — the honest disconnected state stays visible', () => {
    dock()
    expect(screen.getByText(/WebMCP/)).toBeInTheDocument()
  })
})

/**
 * Minimising the dock.
 *
 * Reported from live use on a trip: the rail's chip ("WATCHING · Astrail · generating 86s")
 * cannot be closed and sits on the map. Both halves of that are working as designed — the record
 * is deliberately not a toast, and an overlay dock is deliberately right over a canvas — which is
 * why the missing piece is a control, not a timer and not a route rule.
 *
 * Collapse is only ever allowed to REMOVE chrome. That is what keeps it from re-opening the
 * overlay collision 99c1384 closed: there is no state reachable through this control in which
 * MORE is on screen than before.
 */
describe('WebMcpDock — minimising', () => {
  const minimise = () => screen.getByRole('button', { name: /minimise/i })
  const reopen = () => screen.getByRole('button', { name: /show agent activity/i })

  it('opens expanded for a first visitor — discovery beats tidiness on a first visit', () => {
    dock()
    expect(screen.getByText('READING')).toBeInTheDocument()
    expect(minimise()).toBeInTheDocument()
  })

  it('puts the prompts panel away with the record, over the map', async () => {
    mockPath.value = '/app/trip/abc'
    dock()
    expect(screen.getByText(/move stop 7 to day 3/)).toBeInTheDocument()
    await userEvent.click(minimise())
    expect(screen.queryByText(/move stop 7 to day 3/)).not.toBeInTheDocument()
    expect(screen.queryByText('READING')).not.toBeInTheDocument()
  })

  it('keeps the WebMCP chip while minimised — it is the proof the integration is real', async () => {
    mockPath.value = '/app/trip/abc'
    dock()
    await userEvent.click(minimise())
    expect(screen.getByText(/WebMCP/)).toBeInTheDocument()
    expect(reopen()).toBeInTheDocument()
  })

  it('closes the tool list too, so minimised means the whole corner is quiet', async () => {
    mockPath.value = '/app/trip/abc'
    dock()
    await userEvent.click(screen.getByRole('button', { name: /WebMCP/i }))
    expect(screen.getByText(/Tools an agent can use here/)).toBeInTheDocument()
    await userEvent.click(minimise())
    expect(screen.queryByText(/Tools an agent can use here/)).not.toBeInTheDocument()
  })

  it('remembers the choice across a remount, so a demo does not undo it on every navigation', async () => {
    const first = dock()
    await userEvent.click(minimise())
    first.unmount()

    dock()
    expect(screen.queryByText('READING')).not.toBeInTheDocument()
    expect(reopen()).toBeInTheDocument()
  })

  it('forgets it again once expanded', async () => {
    const first = dock()
    await userEvent.click(minimise())
    await userEvent.click(reopen())
    first.unmount()

    dock()
    expect(screen.getByText('READING')).toBeInTheDocument()
  })

  it('opens expanded in a browser whose storage throws rather than not at all', () => {
    // Private windows reject localStorage outright. A remembered preference is not worth a blank
    // corner, and the safe direction is the discoverable one.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    dock()
    expect(screen.getByText('READING')).toBeInTheDocument()
  })

  it('still minimises for this session when the write is refused', async () => {
    // Safari's private mode throws on the WRITE, not on the read, and the collapse happens either
    // way — `setCollapsed` is already queued before the throw. So the only thing that separates a
    // guarded write from an unguarded one is whether the click leaves an uncaught error behind.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const escaped: unknown[] = []
    const onError = (e: ErrorEvent) => { escaped.push(e.error); e.preventDefault() }
    window.addEventListener('error', onError)
    try {
      dock()
      await userEvent.click(minimise())
      expect(screen.queryByText('READING')).not.toBeInTheDocument()
      expect(escaped).toEqual([])
    } finally {
      window.removeEventListener('error', onError)
    }
  })

  it('does not let expanding bring the prompts panel onto a document route', async () => {
    // The 99c1384 regression guard. /app is a paper document with a scrolling content column,
    // and the panel measured covering its Save button. Collapse must not be a way back in.
    dock()
    await userEvent.click(minimise())
    await userEvent.click(reopen())
    expect(screen.getByText('READING')).toBeInTheDocument()
    expect(screen.queryByText(/What can I do here\?/)).not.toBeInTheDocument()
  })

  it('keeps the document route read-back cap after a collapse and expand', async () => {
    dock(4)
    await userEvent.click(minimise())
    await userEvent.click(reopen())
    await userEvent.click(screen.getByLabelText('Show earlier agent activity'))
    expect(screen.getByLabelText('Earlier agent activity').className).toContain('max-h-36')
  })
})

/**
 * Nothing in the dock may take a click on a region it does not paint.
 *
 * This is 99c1384's finding again, on the route that fix deliberately spared. There it was an
 * opaque panel over the /app content column — visible, at least. Here it was invisible: the status
 * chip's wrapper is `w-[min(22rem,100%)]` with the chip right-aligned inside it, and the WHOLE
 * wrapper carried `pointer-events-auto` while only the chip was painted. Measured on the demo trail
 * with elementFromPoint: a 352x30 catcher around a 171px chip at 1280x800, and around a 47px chip
 * at 390x844 — a 181px and a 305px strip of transparent nothing that ate every click on the map
 * behind it, with no visual cue that anything was there. The dock's own header comment already
 * states the rule ("`pointer-events-none` on the column with `auto` on the children"); the status
 * chip was the one child that broke it.
 *
 * jsdom has no layout engine, so this cannot be a geometry assertion. It is the structural
 * invariant underneath the geometry: a node that accepts a pointer must be a control, a painted
 * surface, or the scroller that needs the wheel. Anything else is a catcher the user cannot see.
 */
describe('WebMcpDock — the dock never swallows an invisible click', () => {
  const invisibleCatchers = () => {
    const el = document.querySelector('div.fixed.bottom-0')
    if (!el) throw new Error('dock not rendered')
    return Array.from(el.querySelectorAll('.pointer-events-auto'))
      .filter((n) => {
        const cn = String(n.className)
        // A button is its own affordance; `bg-` means the user can see what they are hitting;
        // the read-back list must keep the wheel to scroll and is filled edge to edge by cards.
        return n.tagName !== 'BUTTON' && !/\bbg-/.test(cn) && !cn.includes('overflow-y-auto')
      })
      .map((n) => String(n.className).replace(/\s+/g, ' ').slice(0, 80))
  }

  it('paints every surface that accepts a pointer, over the map', () => {
    mockPath.value = '/app/trip/abc'
    dock()
    expect(invisibleCatchers()).toEqual([])
  })

  it('paints every surface that accepts a pointer, on a document route', () => {
    dock()
    expect(invisibleCatchers()).toEqual([])
  })

  it('still holds with the tool list and the read-back both open', async () => {
    mockPath.value = '/app/trip/abc'
    dock(4)
    await userEvent.click(screen.getByLabelText('Show earlier agent activity'))
    await userEvent.click(screen.getByRole('button', { name: /WebMCP/i }))
    expect(screen.getByText(/Tools an agent can use here/)).toBeInTheDocument()
    expect(invisibleCatchers()).toEqual([])
  })

  it('still holds while minimised', async () => {
    mockPath.value = '/app/trip/abc'
    dock()
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))
    expect(invisibleCatchers()).toEqual([])
  })
})

/**
 * The fold is the DOCK's control, not the rail's.
 *
 * It lived on the rail, which renders nothing until a tool has run — so the one state a judge
 * actually arrives in, a first visit to /app/trip/demo with no agent activity, had the prompts
 * panel taking ~22% of a phone viewport and no fold anywhere. The only escape was the panel's own
 * ✕, which dismisses the examples permanently. "Not right now" is a much better thing to offer
 * someone than "never show me this again", and it has to be reachable before the agent acts.
 */
describe('WebMcpDock — the fold works before anything has happened', () => {
  it('offers the fold with no activity at all, over the map', () => {
    mockPath.value = '/app/trip/abc'
    dock(0)
    expect(screen.getByText(/move stop 7 to day 3/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /minimise/i })).toBeInTheDocument()
  })

  it('folds the prompts panel away when there is no rail to fold with it', async () => {
    mockPath.value = '/app/trip/abc'
    dock(0)
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))
    expect(screen.queryByText(/move stop 7 to day 3/)).not.toBeInTheDocument()
    // Still findable: the fold is a fold, never a vanishing.
    expect(screen.getByRole('button', { name: /show agent activity/i })).toBeInTheDocument()
    expect(screen.getByText(/WebMCP/)).toBeInTheDocument()
  })

  it('unfolds again from that state', async () => {
    mockPath.value = '/app/trip/abc'
    dock(0)
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))
    await userEvent.click(screen.getByRole('button', { name: /show agent activity/i }))
    expect(screen.getByText(/move stop 7 to day 3/)).toBeInTheDocument()
  })

  it('offers no fold on a bare document route — there would be nothing under it', () => {
    // /app with no activity is the chip and nothing else. A fold there is a control over a
    // scrolling content column that folds away nothing, which is what 99c1384 was about.
    dock(0)
    expect(screen.queryByRole('button', { name: /minimise/i })).toBeNull()
  })

  it('offers no fold in a browser with no agent', () => {
    mockPath.value = '/app/trip/abc'
    render(
      <WebMcpRegistryProvider>
        <WebMcpDock />
      </WebMcpRegistryProvider>,
    )
    expect(screen.queryByRole('button', { name: /minimise/i })).toBeNull()
  })

  it('still announces a fresh action to a screen reader while folded', async () => {
    // Folded, the rail is unmounted, so the live region it used to carry goes with it. The
    // count is the only thing left that can say an agent just did something.
    mockPath.value = '/app/trip/abc'
    dock(0)
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))
    expect(screen.getByLabelText('Agent activity')).toHaveAttribute('aria-live', 'polite')
  })
})

/**
 * The count on the folded pill.
 *
 * This coverage used to sit on the rail and moved here with the control. A silent agent action is
 * the thing the rail exists to prevent, so folding may not mute one — but auto-expanding on every
 * arrival would undo the fold three times a minute during a generation. The count is the middle.
 */
describe('WebMcpDock — what arrives while folded', () => {
  let api: ReturnType<typeof useWebMcpRegistry> | null = null
  const Capture = () => { api = useWebMcpRegistry(); return null }

  const live = (entries = 1) =>
    render(
      <WebMcpRegistryProvider>
        <Capture />
        <Session entries={entries} />
        <WebMcpDock />
      </WebMcpRegistryProvider>,
    )

  beforeEach(() => { api = null; mockPath.value = '/app/trip/abc' })

  it('counts it instead of opening itself over the map', async () => {
    live()
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))
    await act(async () => { api!.beginActivity('get_itinerary'); api!.beginActivity('get_map_view') })

    expect(screen.queryByText('READING')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show agent activity, 2 new/i })).toBeInTheDocument()
  })

  it('says when one of those was a change, because a count flattens the difference', async () => {
    live()
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))
    await act(async () => { api!.beginActivity('get_map_view'); api!.beginActivity('save_reels') })

    // In the ACCESSIBLE NAME, not only the dot: the user who cannot see the dot is exactly the
    // user who cannot otherwise tell that something was written.
    expect(
      screen.getByRole('button', { name: /show agent activity, 2 new, including a change/i }),
    ).toBeInTheDocument()
  })

  it('counts nothing when nothing has happened since', async () => {
    live()
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))
    const pill = screen.getByRole('button', { name: /show agent activity/i })
    expect(pill).toHaveAccessibleName('Show agent activity')
    expect(pill.textContent).not.toMatch(/\d/)
  })

  it('counts only what arrived after a clear', async () => {
    live(3)
    await userEvent.click(screen.getByRole('button', { name: /clear agent activity/i }))
    await userEvent.click(screen.getByRole('button', { name: /minimise/i }))
    await act(async () => { api!.beginActivity('save_reels') })

    // The three cleared reads are below the fold marker, so only the new write counts.
    expect(
      screen.getByRole('button', { name: /show agent activity, 1 new, including a change/i }),
    ).toBeInTheDocument()
  })
})
