import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import CardFanCarousel, { type CardItem } from '@/components/ui/card-fan-carousel'

const card = (n: number): CardItem => ({
  imgUrl: `https://img.test/${n}.jpg`,
  alt: `Reel ${n}`,
})

describe('CardFanCarousel', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders one image per card with its alt text', () => {
    render(<CardFanCarousel cards={[card(1), card(2), card(3)]} />)

    const images = screen.getAllByRole('img')
    expect(images).toHaveLength(3)
    expect(screen.getByAltText('Reel 1')).toBeInTheDocument()
    expect(screen.getByAltText('Reel 2')).toBeInTheDocument()
    expect(screen.getByAltText('Reel 3')).toBeInTheDocument()
  })

  it('renders pagination controls when there are more than seven cards', () => {
    const cards = Array.from({ length: 9 }, (_, i) => card(i))
    render(<CardFanCarousel cards={cards} />)

    expect(screen.getByRole('button', { name: 'Previous' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument()
    // One dot indicator per card.
    expect(document.querySelectorAll('span.rounded-full')).toHaveLength(cards.length)
  })

  it('renders no pagination controls at or below seven cards', () => {
    render(<CardFanCarousel cards={Array.from({ length: 7 }, (_, i) => card(i))} />)

    expect(screen.queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
  })

  it('renders nothing when given no cards', () => {
    const { container } = render(<CardFanCarousel cards={[]} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('positions fan cards absolutely so the fan cannot collapse to 0px', () => {
    render(<CardFanCarousel cards={[card(1), card(2), card(3)]} />)

    const fanCard = document.querySelector('.fan-card')
    expect(fanCard).not.toBeNull()
    // Guards the 0px-collapse bug: without `absolute` the cards share flow and the
    // gsap-driven fan has no sized, stacked stage to spread across.
    expect(fanCard?.className).toContain('absolute')
  })
})
