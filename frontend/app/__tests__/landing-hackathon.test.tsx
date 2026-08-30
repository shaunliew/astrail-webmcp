import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/story/stage/StoryStage', () => ({
  default: () => <main data-testid="story-stage" />,
}))

vi.mock('next/font/google', () => ({
  Fraunces: () => ({ variable: '--font-fraunces' }),
  Figtree: () => ({ variable: '--font-figtree' }),
  IBM_Plex_Mono: () => ({ variable: '--font-ibm-plex-mono' }),
}))

vi.mock('next/script', () => ({ default: () => null }))

import LandingPage from '../page'
import { metadata } from '../layout'

describe('WebMCP Challenge landing', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_EMAIL', '')
    vi.stubEnv('NEXT_PUBLIC_DEMO_PASSWORD', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('says plainly that this is a challenge build, and sends nobody to a product', () => {
    render(<LandingPage />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'This is a WebMCP Challenge build — an experiment in planning trips with an agent, not a product you can sign up for.',
    )
    // The notice used to point at astrail.xyz. This deployment stands alone: routing a judge to a
    // different product mid-evaluation is a distraction, and it invited reading the two as one.
    expect(screen.queryByRole('link', { name: /astrail\.xyz/i })).toBeNull()
  })

  it('documents the challenge additions and links to the full eligibility record', () => {
    render(<LandingPage />)

    const section = screen.getByRole('region', { name: "What's new for this hackathon" })
    expect(within(section).getAllByRole('listitem')).toHaveLength(7)
    // The claims a judge can check against the repo in one grep.
    expect(section).toHaveTextContent('16 tools')
    expect(section).toHaveTextContent('document.modelContext.registerTool()')
    expect(section).toHaveTextContent('get_app_state')
    expect(within(section).getByRole('link', { name: /full new-vs-pre-existing record/i }))
      .toHaveAttribute(
        'href',
        'https://github.com/MalaysiaKaki/astrail/blob/feat/webmcp/docs/webmcp/WHATS-NEW.md',
      )
  })

  it('shows judge setup instructions before sign-in', () => {
    render(<LandingPage />)

    const section = screen.getByRole('region', { name: 'For judges' })
    expect(section).toHaveTextContent("ChatGPT desktop app's built-in browser")
    expect(section).toHaveTextContent('GPT-5.6 Sol or Terra')
    expect(section).toHaveTextContent('Luna has WebMCP disabled')
    expect(section).toHaveTextContent('Settings > Browser > Permissions > Enable site tools')
    expect(section).toHaveTextContent('Site tools arrow')
    expect(section).toHaveTextContent('WebMCP chip')
  })

  it('renders the configured demo account for judges', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_EMAIL', 'judge@example.com')
    vi.stubEnv('NEXT_PUBLIC_DEMO_PASSWORD', 'demo-password')

    render(<LandingPage />)

    const section = screen.getByRole('region', { name: 'For judges' })
    expect(within(section).getByText('Demo account')).toBeInTheDocument()
    expect(within(section).getByText('judge@example.com')).toBeInTheDocument()
    expect(within(section).getByText('demo-password')).toBeInTheDocument()
    expect(within(section).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('blocks submission visibly when either demo credential variable is missing', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_EMAIL', 'judge@example.com')
    vi.stubEnv('NEXT_PUBLIC_DEMO_PASSWORD', '')

    render(<LandingPage />)

    const warning = screen.getByRole('alert')
    expect(warning).toHaveTextContent('Submission blocked')
    expect(warning).toHaveTextContent('NEXT_PUBLIC_DEMO_EMAIL')
    expect(warning).toHaveTextContent('NEXT_PUBLIC_DEMO_PASSWORD')
    expect(screen.queryByText('judge@example.com')).not.toBeInTheDocument()
  })

  it('marks the whole challenge deployment noindex and nofollow', () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false })
  })
})

/*
 * The no-account route in. `/app/trip/demo` is the only /app path a signed-out judge can open,
 * and until now the landing page never said so — it offered a sign-in and a waitlist and nothing
 * else. These pin the three things that make the link worth having: that it is there, that it
 * points at the exact string middleware allowlists, and that it promises only what a judge in
 * Safari actually gets.
 */
describe('the no-account sample trail', () => {
  const demoLink = () =>
    screen.getByRole('link', { name: /see a finished trip .* no account needed/i })

  it('offers the sample trail from the sticky challenge notice, above everything else', () => {
    render(<LandingPage />)

    // Inside the notice, not buried in a card: the notice is sticky and first, so it is the one
    // surface a judge is guaranteed to see on a phone, where the two-column grid stacks.
    expect(within(screen.getByRole('status')).getByRole('link', { name: /no account needed/i }))
      .toBe(demoLink())
  })

  it('points at exactly the path middleware allowlists', () => {
    render(<LandingPage />)

    // EXACT match, never a prefix or a suffix: middleware.ts allowlists the literal string
    // '/app/trip/demo'. A suffix or a query string is a different string to that guard and would
    // bounce a signed-out judge to /sign-in.
    expect(demoLink()).toHaveAttribute('href', '/app/trip/demo')
  })

  it('uses the same literal middleware allowlists, character for character', () => {
    /* The DOM cannot see the one mutation most likely to happen here: next/link normalises a
       trailing slash away, so a source `'/app/trip/demo/'` still RENDERS as `/app/trip/demo` and
       the assertion above stays green. Relying on that normalisation is exactly what we were told
       not to do, so pin the thing the middleware guard actually compares — the literal itself —
       and pin it against middleware's own literal, so moving either side reddens this. */
    const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')
    const linked = read('components/landing/ChallengeBanner.tsx')
      .match(/const SAMPLE_TRAIL_PATH = '([^']*)'/)?.[1]
    const allowlisted = read('middleware.ts').match(/nextUrl\.pathname === '([^']*)'/)?.[1]

    expect(linked).toBe('/app/trip/demo')
    expect(allowlisted).toBe(linked)
  })

  it('says in the link itself that it costs no account, and nothing to open', () => {
    render(<LandingPage />)

    expect(demoLink()).toHaveAccessibleName(/no account needed/i)
    expect(screen.getByRole('status')).toHaveTextContent(
      'A real generated trail, free to open, in any browser.',
    )
  })

  it('never promises the agent here — the tools need a WebMCP-capable browser', () => {
    render(<LandingPage />)

    // A judge opening this in Safari gets the map and the evidence and NO tools. Promising an
    // agent and delivering a static page is worse than promising nothing; the browser
    // requirement is stated once, in the "For judges" card that is about setup.
    const name = demoLink().textContent ?? ''
    expect(name).not.toMatch(/agent|webmcp|tool/i)
  })
})
