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

  it('keeps the challenge build distinct from production', () => {
    render(<LandingPage />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'This is a WebMCP Challenge build of Astrail — an experiment in planning trips with an agent.',
    )
    expect(screen.getByRole('link', { name: 'astrail.xyz' })).toHaveAttribute(
      'href',
      'https://astrail.xyz',
    )
  })

  it('documents the challenge additions and links to the full eligibility record', () => {
    render(<LandingPage />)

    const section = screen.getByRole('region', { name: "What's new for this hackathon" })
    expect(within(section).getAllByRole('listitem')).toHaveLength(5)
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
