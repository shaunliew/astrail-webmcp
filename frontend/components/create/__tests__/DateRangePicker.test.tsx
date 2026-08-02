import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import DateRangePicker from '@/components/create/DateRangePicker'

function openOn(startDate = '', endDate = '') {
  const onChange = vi.fn()
  render(<DateRangePicker startDate={startDate} endDate={endDate} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: /trip dates/i }))
  return { onChange, dialog: screen.getByRole('dialog') }
}

describe('DateRangePicker', () => {
  it('shows a placeholder trigger when no range is set', () => {
    render(<DateRangePicker startDate="" endDate="" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /select trip dates/i })).toHaveTextContent('Add trip dates')
  })

  it('renders the committed range and night count on the trigger', () => {
    render(<DateRangePicker startDate="2026-08-01" endDate="2026-08-04" onChange={vi.fn()} />)
    expect(screen.getByText('Aug 1 → Aug 4')).toBeInTheDocument()
    expect(screen.getByText('3 nights')).toBeInTheDocument()
  })

  it('opens to the month of the committed start date', () => {
    const { dialog } = openOn('2026-08-01', '2026-08-04')
    expect(within(dialog).getByText('August 2026')).toBeInTheDocument()
  })

  it('commits a normalized [lo, hi] range regardless of click order', () => {
    const { onChange, dialog } = openOn('2026-08-01', '2026-08-31')
    // Click the 20th first, then the 5th — should still emit [05, 20].
    fireEvent.click(within(dialog).getByRole('button', { name: 'August 20, 2026' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'August 5, 2026' }))
    expect(onChange).toHaveBeenCalledWith('2026-08-05', '2026-08-20')
  })

  it('does not commit on the first click (range needs two endpoints)', () => {
    const { onChange, dialog } = openOn('2026-08-01', '2026-08-31')
    fireEvent.click(within(dialog).getByRole('button', { name: 'August 10, 2026' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument() // stays open
  })

  it('navigates months with the chevrons', () => {
    const { dialog } = openOn('2026-08-01', '2026-08-04')
    fireEvent.click(within(dialog).getByRole('button', { name: /next month/i }))
    expect(within(dialog).getByText('September 2026')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /previous month/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /previous month/i }))
    expect(within(dialog).getByText('July 2026')).toBeInTheDocument()
  })

  it('closes on Escape without committing', () => {
    const { onChange, dialog } = openOn('2026-08-01', '2026-08-04')
    fireEvent.keyDown(within(dialog).getByRole('grid'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables days before minDate', () => {
    const onChange = vi.fn()
    // startDate pins the opening month to August 2026 deterministically.
    render(<DateRangePicker startDate="2026-08-15" endDate="2026-08-20" minDate="2026-08-10" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /trip dates/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'August 5, 2026' })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'August 5, 2026' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('selects a single-day (same-day) trip', () => {
    const { onChange, dialog } = openOn('2026-08-01', '2026-08-31')
    fireEvent.click(within(dialog).getByRole('button', { name: 'August 12, 2026' }))
    fireEvent.click(screen.getByRole('button', { name: 'August 12, 2026' }))
    expect(onChange).toHaveBeenCalledWith('2026-08-12', '2026-08-12')
  })

  it('selects a range by keyboard (arrows + Enter), rolling across a month boundary', () => {
    // Opens on August with focus seeded to the 10th (the committed start).
    const { onChange, dialog } = openOn('2026-08-10', '2026-08-10')
    const grid = within(dialog).getByRole('grid')
    fireEvent.keyDown(grid, { key: 'Enter' })       // anchor = Aug 10
    fireEvent.keyDown(grid, { key: 'ArrowDown' })   // +7 → Aug 17
    fireEvent.keyDown(grid, { key: 'ArrowRight' })  // +1 → Aug 18
    fireEvent.keyDown(grid, { key: 'Enter' })       // commit [Aug 10, Aug 18]
    expect(onChange).toHaveBeenCalledWith('2026-08-10', '2026-08-18')
  })

  it('arrow-navigates into the next month, updating the grid heading', () => {
    const { dialog } = openOn('2026-08-30', '2026-08-30')
    const grid = within(dialog).getByRole('grid')
    fireEvent.keyDown(grid, { key: 'ArrowDown' }) // Aug 30 + 7 → Sep 6
    expect(within(dialog).getByText('September 2026')).toBeInTheDocument()
  })

  const tabbableDay = (dialog: HTMLElement) =>
    within(dialog).getAllByRole('button')
      .find((b) => b.getAttribute('tabindex') === '0' && b.hasAttribute('data-iso'))
      ?.getAttribute('data-iso')

  it('moves real focus onto the day cell as arrows navigate', () => {
    const { dialog } = openOn('2026-08-10', '2026-08-10')
    expect(document.activeElement?.getAttribute('data-iso')).toBe('2026-08-10') // focused on open
    fireEvent.keyDown(within(dialog).getByRole('grid'), { key: 'ArrowRight' })
    expect(document.activeElement?.getAttribute('data-iso')).toBe('2026-08-11')
    expect(tabbableDay(dialog)).toBe('2026-08-11') // roving tabindex followed
  })

  it('keeps focus on a mouse-clicked day so keyboard continues from there', () => {
    // Regression: pick() must sync focusDay, else ArrowRight+Enter commits from the stale seed.
    const { onChange, dialog } = openOn('2026-08-01', '2026-08-01')
    fireEvent.click(within(dialog).getByRole('button', { name: 'August 20, 2026' })) // anchor + focus → 20
    fireEvent.keyDown(within(dialog).getByRole('grid'), { key: 'ArrowRight' })        // → 21
    fireEvent.keyDown(within(dialog).getByRole('grid'), { key: 'Enter' })             // commit
    expect(onChange).toHaveBeenCalledWith('2026-08-20', '2026-08-21')
  })

  it('carries a tabbable/focus day into the new month after a chevron click', () => {
    // Regression: without moving focusDay, the new month has no tabbable cell and Tab escapes.
    const { onChange, dialog } = openOn('2026-08-15', '2026-08-15')
    fireEvent.click(within(dialog).getByRole('button', { name: /next month/i }))
    expect(tabbableDay(dialog)).toBe('2026-09-15')
    const grid = within(dialog).getByRole('grid')
    fireEvent.keyDown(grid, { key: 'Enter' })      // anchor Sep 15
    fireEvent.keyDown(grid, { key: 'ArrowRight' }) // Sep 16
    fireEvent.keyDown(grid, { key: 'Enter' })      // commit
    expect(onChange).toHaveBeenCalledWith('2026-09-15', '2026-09-16')
  })

  it('PageDown advances exactly one month, even from a 31st (no month skip)', () => {
    const { dialog } = openOn('2026-01-31', '2026-01-31')
    fireEvent.keyDown(within(dialog).getByRole('grid'), { key: 'PageDown' })
    expect(within(dialog).getByText('February 2026')).toBeInTheDocument() // not March
  })

  it('opens clamped to minDate when the committed start is earlier', () => {
    const onChange = vi.fn()
    render(<DateRangePicker startDate="2026-07-01" endDate="2026-07-05" minDate="2026-08-10" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /trip dates/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('August 2026')).toBeInTheDocument() // not the disabled July
    const aug10 = within(dialog).getByRole('button', { name: 'August 10, 2026' })
    expect(aug10).toBeEnabled()
    expect(tabbableDay(dialog)).toBe('2026-08-10') // focus seeded to an enabled day
  })

  it('does not crash rendering a malformed date prop', () => {
    expect(() =>
      render(<DateRangePicker startDate="not-a-date" endDate="" onChange={vi.fn()} />),
    ).not.toThrow()
    expect(screen.getByRole('button', { name: /select trip dates/i })).toHaveTextContent('Add trip dates')
  })
})
