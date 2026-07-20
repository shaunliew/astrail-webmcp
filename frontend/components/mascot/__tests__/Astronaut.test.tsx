import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import Astronaut from '@/components/mascot/Astronaut'

const mascot = (container: HTMLElement) => container.querySelector('[data-mascot="astronaut"]')

describe('Astronaut', () => {
  it('is decorative by default: aria-hidden, no role', () => {
    const { container } = render(<Astronaut />)
    const svg = mascot(container)
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).not.toHaveAttribute('role')
  })

  it('carries an accessible name when given a label', () => {
    const { container } = render(<Astronaut label="Astrail is building your trip" />)
    const svg = mascot(container)
    expect(svg).toHaveAttribute('role', 'img')
    expect(svg).toHaveAttribute('aria-label', 'Astrail is building your trip')
    expect(svg).not.toHaveAttribute('aria-hidden')
  })

  it('animates the trail only in the waiting variant', () => {
    const { container: idle } = render(<Astronaut />)
    const { container: waiting } = render(<Astronaut variant="waiting" />)
    expect(idle.querySelector('.astronaut-trail--waiting')).toBeNull()
    expect(waiting.querySelector('.astronaut-trail--waiting')).not.toBeNull()
  })

  it('registers the waiting animation in the reduced-motion block', () => {
    // DESIGN.md rule: any new animation must resolve to none under
    // prefers-reduced-motion (globals.css reduced-motion block).
    const css = readFileSync(resolve(__dirname, '../../../app/globals.css'), 'utf8')
    const reducedBlock = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedBlock).toContain('.astronaut-trail--waiting')
  })

  it('scales from the size prop at a fixed 3:2 ratio', () => {
    const { container } = render(<Astronaut size={32} />)
    const svg = mascot(container)
    expect(svg).toHaveAttribute('height', '32')
    expect(svg).toHaveAttribute('width', '48')
  })
})
