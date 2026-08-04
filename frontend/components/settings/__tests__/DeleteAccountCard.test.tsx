import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

// useUser supplies the account email the type-to-confirm dialog matches against.
const { useUser } = vi.hoisted(() => ({ useUser: vi.fn() }))
vi.mock('@/lib/auth/use-user', () => ({ useUser }))

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }))
vi.mock('@/lib/supabase/session', () => ({ getAccessToken }))

// Override ONLY the two endpoint calls; keep the real ApiError so the component's
// `instanceof ApiError` branch matches the errors the test constructs from the same module.
const { requestAccountDeletion, cancelAccountDeletion } = vi.hoisted(() => ({
  requestAccountDeletion: vi.fn(),
  cancelAccountDeletion: vi.fn(),
}))
vi.mock('@/lib/trip/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trip/api')>()
  return { ...actual, requestAccountDeletion, cancelAccountDeletion }
})

import DeleteAccountCard from '@/components/settings/DeleteAccountCard'
import { ApiError } from '@/lib/trip/api'

const EMAIL = 'traveler@example.com'

beforeEach(() => {
  useUser.mockReturnValue({ user: { id: 'u1', name: 'Traveler', email: EMAIL }, loading: false })
  getAccessToken.mockResolvedValue('jwt-token')
  requestAccountDeletion.mockReset()
  cancelAccountDeletion.mockReset()
})

describe('DeleteAccountCard — type-to-confirm', () => {
  it('keeps the confirm button disabled until the typed value EXACTLY matches the account email', () => {
    render(<DeleteAccountCard />)
    fireEvent.click(screen.getByRole('button', { name: /^delete account$/i }))

    const confirm = screen.getByRole('button', { name: /confirm deletion/i })
    const input = screen.getByRole('textbox')

    expect(confirm).toBeDisabled()

    // A partial email (near-miss) stays disabled.
    fireEvent.change(input, { target: { value: 'traveler@examp' } })
    expect(confirm).toBeDisabled()

    // Wrong case of the keyword stays disabled.
    fireEvent.change(input, { target: { value: 'delete' } })
    expect(confirm).toBeDisabled()

    // Exact email unlocks it.
    fireEvent.change(input, { target: { value: EMAIL } })
    expect(confirm).toBeEnabled()
  })

  it('also enables confirm when the literal word DELETE is typed', () => {
    render(<DeleteAccountCard />)
    fireEvent.click(screen.getByRole('button', { name: /^delete account$/i }))
    const confirm = screen.getByRole('button', { name: /confirm deletion/i })

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'DELETE' } })
    expect(confirm).toBeEnabled()
  })

  it('does not enable confirm on an empty field even if the email has not loaded', () => {
    useUser.mockReturnValue({ user: null, loading: true })
    render(<DeleteAccountCard />)
    fireEvent.click(screen.getByRole('button', { name: /^delete account$/i }))
    // Empty confirmText must never match an empty email.
    expect(screen.getByRole('button', { name: /confirm deletion/i })).toBeDisabled()
  })
})

describe('DeleteAccountCard — request', () => {
  it('calls requestAccountDeletion on confirm and renders the returned scheduled date', async () => {
    requestAccountDeletion.mockResolvedValue({ scheduled_for: '2026-08-11T09:00:00.000Z' })
    render(<DeleteAccountCard />)

    fireEvent.click(screen.getByRole('button', { name: /^delete account$/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: EMAIL } })
    fireEvent.click(screen.getByRole('button', { name: /confirm deletion/i }))

    await waitFor(() => expect(requestAccountDeletion).toHaveBeenCalledWith('jwt-token'))
    expect(await screen.findByText(/august 11, 2026/i)).toBeInTheDocument()
    // The delete opener is gone — the account is now pending.
    expect(screen.queryByRole('button', { name: /^delete account$/i })).not.toBeInTheDocument()
  })

  it('surfaces a 503 as "temporarily unavailable" and never claims success', async () => {
    requestAccountDeletion.mockRejectedValue(new ApiError(503, 'deletion_unavailable', 'nope'))
    render(<DeleteAccountCard />)

    fireEvent.click(screen.getByRole('button', { name: /^delete account$/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: EMAIL } })
    fireEvent.click(screen.getByRole('button', { name: /confirm deletion/i }))

    expect(await screen.findByText(/temporarily unavailable/i)).toBeInTheDocument()
    expect(screen.queryByText(/august 11, 2026/i)).not.toBeInTheDocument()
  })
})

describe('DeleteAccountCard — pending banner + cancel', () => {
  it('renders the scheduled date and a Cancel control when already pending', () => {
    render(<DeleteAccountCard initialStatus="pending_deletion" initialScheduledFor="2026-08-11T09:00:00.000Z" />)
    expect(screen.getByText(/august 11, 2026/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel deletion/i })).toBeEnabled()
  })

  it('calls cancelAccountDeletion and returns to the delete control on success', async () => {
    cancelAccountDeletion.mockResolvedValue({ cancelled: true })
    render(<DeleteAccountCard initialStatus="pending_deletion" initialScheduledFor="2026-08-11T09:00:00.000Z" />)

    fireEvent.click(screen.getByRole('button', { name: /cancel deletion/i }))
    await waitFor(() => expect(cancelAccountDeletion).toHaveBeenCalledWith('jwt-token'))
    expect(await screen.findByRole('button', { name: /^delete account$/i })).toBeInTheDocument()
  })

  it('shows the in-progress message and disables Cancel on a deletion_already_started response', async () => {
    cancelAccountDeletion.mockRejectedValue(new ApiError(409, 'deletion_already_started', 'started'))
    render(<DeleteAccountCard initialStatus="pending_deletion" initialScheduledFor="2026-08-11T09:00:00.000Z" />)

    fireEvent.click(screen.getByRole('button', { name: /cancel deletion/i }))
    await waitFor(() => expect(cancelAccountDeletion).toHaveBeenCalledWith('jwt-token'))
    expect(await screen.findByText(/no longer be cancelled/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel deletion/i })).toBeDisabled()
  })
})
