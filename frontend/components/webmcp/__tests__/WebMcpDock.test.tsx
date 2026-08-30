import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
