import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import GlobalError from './global-error'

vi.spyOn(console, 'error').mockImplementation(() => {})

afterEach(cleanup)

describe('GlobalError', () => {
  it('keeps raw error detail private and lets the user retry', () => {
    const reset = vi.fn()
    const error = Object.assign(new Error('private failure detail'), { digest: 'root-123' })

    render(<GlobalError error={error} reset={reset} />)

    expect(screen.queryByText(/private failure detail/)).toBeNull()
    expect(screen.getByText(/root-123/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(reset).toHaveBeenCalledOnce()
  })
})
