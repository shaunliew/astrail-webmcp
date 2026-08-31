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

// The closing CTA's bookend clip drives framer-motion's useInView, which needs an
// IntersectionObserver jsdom does not have. The copy is what is under test, not the video.
vi.mock('@/components/story/PlayOnceVideo', () => ({ default: () => null }))

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
        'https://github.com/shaunliew/astrail-webmcp/blob/main/docs/webmcp/WHATS-NEW.md',
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

  /* Two tests here used to pin the opposite rule: that the page RENDERS the demo credentials from
     `NEXT_PUBLIC_DEMO_EMAIL` / `NEXT_PUBLIC_DEMO_PASSWORD`, and warns loudly when they are unset.
     They went with the feature. What replaces them guards the reason it was removed.

     `NEXT_PUBLIC_*` is inlined into the client bundle at build time. If those vars are set on the
     deployment, their values are readable straight out of the shipped JavaScript whether or not a
     component prints them — so deleting the markup was never the fix, and a test that only checked
     the markup would have passed over a live leak. The READ is the exposure, and it is the read
     these assertions watch. The account spends real Apify and OpenAI credit. */

  it('never reads a demo credential out of the client bundle', () => {
    // Source-level on purpose, and the one case where that beats rendering: a `process.env` read
    // that reaches no JSX still ships its value. Nothing rendered could reveal that.
    const page = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

    expect(page, 'page.tsx reads a NEXT_PUBLIC demo credential again').not.toMatch(
      /process\.env\.NEXT_PUBLIC_DEMO_(EMAIL|PASSWORD)/,
    )
  })

  it('offers judges a route to the credentials without printing anything like one', () => {
    // Set them anyway: if the reads ever come back, this fails on real-looking values rather than
    // passing because the test environment happened to be empty.
    vi.stubEnv('NEXT_PUBLIC_DEMO_EMAIL', 'judge@example.com')
    vi.stubEnv('NEXT_PUBLIC_DEMO_PASSWORD', 'demo-password')

    render(<LandingPage />)
    const section = screen.getByRole('region', { name: 'For judges' })
    const shown = section.textContent ?? ''

    // The card still has to get a judge in — pointing at Devpost's private field is the whole
    // replacement, and a card that just went quiet would read as an oversight to reinstate.
    expect(section).toHaveTextContent(/Devpost/i)
    // Nothing credential-shaped: no address, and no labelled password.
    expect(shown, 'an email address is rendered in the judges card').not.toMatch(
      /[\w.+-]+@[\w-]+\.[\w.]+/,
    )
    // The credential pair was a <dl> of Email/Password terms, and a labelled pair is what a <dl>
    // is FOR here — so its absence is the structural half of the same guard. Checked as structure
    // rather than as words because the word "password" belongs in the honest sentence that stayed.
    expect(section.querySelector('dl'), 'a labelled term/value pair is back in the judges card')
      .toBeNull()
    expect(within(section).queryByText('judge@example.com')).not.toBeInTheDocument()
    expect(within(section).queryByText('demo-password')).not.toBeInTheDocument()
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

describe('the story deck does not promise tools on the page that registers none', () => {
  /* `/` registers ZERO WebMCP tools — `GlobalTools` mounts in the /app layout only
     (app/app/layout.tsx). The closing CTA nonetheless read "Open THIS page in ChatGPT's built-in
     browser and the agent can read it, save the Reels you paste…", which is the same defect the
     hero carried and nothing was watching either of them. That is why this exists: the claim is
     cheap to reintroduce, reads perfectly well, and is false.

     Rendered rather than grepped, because the sentence a judge reads is the thing under test and
     a source-level match would pass on copy that never reaches the screen. */
  it('sends the reader to the app, not to the page they are standing on', async () => {
    const { default: FinalCTA } = await import('@/components/story/sections/FinalCTA')
    render(<FinalCTA />)

    const copy = screen.getByText(/built-in\s+browser/i).textContent ?? ''
    expect(copy).toMatch(/not this page/i)
    // The no-account path is the other half: an account was never the only way in, and the CTA
    // used to say "Sign in first" as though it were.
    expect(copy).toMatch(/sample trail opens with no account/i)
  })
})
