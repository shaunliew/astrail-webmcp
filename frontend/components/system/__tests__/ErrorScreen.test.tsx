import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import RootError from '@/app/error'
import AppError from '@/app/app/error'

// The boundary logs the real error to the console; keep test output clean.
vi.spyOn(console, 'error').mockImplementation(() => {})

const boom = Object.assign(new Error('secret internal detail'), { digest: 'abc123' })

describe.each([
  ['root boundary', RootError],
  ['app boundary', AppError],
])('%s', (_name, Boundary) => {
  afterEach(cleanup)

  it('renders the composed error screen and wires reset to the retry control', () => {
    const reset = vi.fn()
    render(<Boundary error={boom} reset={reset} />)
    expect(screen.getByRole('heading', { name: 'Lost signal' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('never surfaces the raw error message, only the digest', () => {
    render(<Boundary error={boom} reset={vi.fn()} />)
    expect(screen.queryByText(/secret internal detail/)).toBeNull()
    expect(screen.getByText(/abc123/)).toBeInTheDocument()
  })

  it('omits the reference line when there is no digest, and holds the mascot still', () => {
    const { container } = render(<Boundary error={new Error('nope')} reset={vi.fn()} />)
    expect(screen.queryByText(/ref/i)).toBeNull()
    const mascot = container.querySelector('[data-mascot="astronaut"]')
    expect(mascot).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('.astronaut-trail--waiting')).toBeNull()
  })
})
