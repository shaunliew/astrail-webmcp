import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
    expect(section).toHaveTextContent('TODO: Demo credentials')
  })

  it('marks the whole challenge deployment noindex and nofollow', () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false })
  })
})
