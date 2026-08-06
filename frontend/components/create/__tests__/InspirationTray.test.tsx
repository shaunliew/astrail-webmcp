import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import InspirationTray from '@/components/create/InspirationTray'
import { buildReelItems, makeRequestedPlace } from '@/lib/trip/parse-inspiration'

describe('InspirationTray', () => {
  it('parses a pasted reel URL into a card via onChange', () => {
    const onChange = vi.fn()
    render(<InspirationTray items={[]} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add links/i }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0]
    expect(next).toHaveLength(1)
    expect(next[0].normalized_reel_url).toBe('https://www.instagram.com/reel/AAA/')
  })

  it('adds a requested place keeping the verbatim text', () => {
    const onChange = vi.fn()
    render(<InspirationTray items={[]} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/add a place/i), { target: { value: 'Tokyo Disneyland' } })
    fireEvent.click(screen.getByRole('button', { name: /add place/i }))
    const next = onChange.mock.calls[0][0]
    expect(next[0].requested_place_text).toBe('Tokyo Disneyland')
  })

  it('renders existing items with a type badge and a remove control', () => {
    const items = [
      ...buildReelItems('https://www.instagram.com/reel/AAA/', []).items,
      makeRequestedPlace('Shibuya Sky', [])!,
    ]
    const onChange = vi.fn()
    render(<InspirationTray items={items} onChange={onChange} />)
    expect(screen.getByText('Shibuya Sky')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toHaveLength(1) // one item removed
  })

  it('badges a saved reel as Reel and a /p/ post as Post (URL-kind badge)', () => {
    const items = buildReelItems(
      'https://www.instagram.com/reel/AAA/ https://www.instagram.com/p/BBB/', [],
    ).items
    render(<InspirationTray items={items} onChange={vi.fn()} />)
    expect(screen.getByText('Reel')).toBeInTheDocument()
    expect(screen.getByText('Post')).toBeInTheDocument()
  })

  it('shows the max-reels notice when five reels are present', () => {
    const items = buildReelItems(
      Array.from({ length: 5 }, (_, n) => `https://www.instagram.com/reel/R${n}/`).join('\n'), [],
    ).items
    render(<InspirationTray items={items} onChange={vi.fn()} />)
    expect(screen.getByText(/max.*5.*reel/i)).toBeInTheDocument()
  })
})
