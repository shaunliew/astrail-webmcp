import { fireEvent, screen, within } from '@testing-library/react'

// Shared test helper: drive the bespoke DateRangePicker to commit a valid start<end range.
// Opens the calendar, then clicks the first and last enabled day of the shown month. Exact
// dates don't matter to the callers (generation is mocked) — they only need `canGenerate`
// satisfied. Returns the committed [start, end] ISO strings so callers can assert on them.
export function pickTripDates(): { start: string; end: string } {
  fireEvent.click(screen.getByRole('button', { name: /trip dates/i }))
  const dialog = screen.getByRole('dialog')
  const days = within(dialog)
    .queryAllByRole('button')
    .filter((b): b is HTMLButtonElement => b.hasAttribute('data-iso') && !(b as HTMLButtonElement).disabled)
  const first = days[0]
  const last = days[days.length - 1]
  fireEvent.click(first)
  fireEvent.click(last)
  return { start: first.getAttribute('data-iso')!, end: last.getAttribute('data-iso')! }
}
