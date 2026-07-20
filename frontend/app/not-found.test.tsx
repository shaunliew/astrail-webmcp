import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    <a href={typeof href === 'string' ? href : ''} {...props}>{children}</a>,
}))

import NotFound from '@/app/not-found'

describe('NotFound', () => {
  it('is composed, decorated by the mascot, and offers a route home', () => {
    const { container } = render(<NotFound />)
    expect(screen.getByRole('heading', { name: 'Off the trail' })).toBeInTheDocument()
    expect(screen.getByText("There's nothing mapped at this address.")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /back to astrail/i })).toHaveAttribute('href', '/')
    const main = container.querySelector('main')
    expect(main).toHaveClass('app-shell', 'items-center', 'text-center')
    const mascot = container.querySelector('[data-mascot="astronaut"]')
    expect(mascot).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('.astronaut-trail--waiting')).toBeNull()
  })
})
