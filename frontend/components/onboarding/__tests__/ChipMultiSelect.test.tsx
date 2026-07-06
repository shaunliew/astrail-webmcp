import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ChipMultiSelect from '@/components/onboarding/ChipMultiSelect'

describe('ChipMultiSelect', () => {
  it('renders every option as a toggle button', () => {
    render(<ChipMultiSelect ariaLabel="Style" options={['a', 'b', 'c']} selected={[]} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'a' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'c' })).toBeInTheDocument()
  })

  it('marks selected options with aria-pressed', () => {
    render(<ChipMultiSelect ariaLabel="Style" options={['a', 'b']} selected={['b']} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'a' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'b' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onToggle with the clicked option', () => {
    const onToggle = vi.fn()
    render(<ChipMultiSelect ariaLabel="Style" options={['a', 'b']} selected={[]} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button', { name: 'b' }))
    expect(onToggle).toHaveBeenCalledWith('b')
  })
})
