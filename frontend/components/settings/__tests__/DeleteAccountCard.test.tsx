import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

// useUser supplies the account email the type-to-confirm dialog matches against.
const { useUser } = vi.hoisted(() => ({ useUser: vi.fn() }))
vi.mock('@/lib/auth/use-user', () => ({ useUser }))

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }))
vi.mock('@/lib/supabase/session', () => ({ getAccessToken }))

// Override ONLY the three endpoint calls; keep the real ApiError so the component's
// `instanceof ApiError` branch matches the errors the test constructs from the same module.
const { requestAccountDeletion, cancelAccountDeletion, getAccountDeletionStatus } = vi.hoisted(() => ({
  requestAccountDeletion: vi.fn(),
  cancelAccountDeletion: vi.fn(),
  getAccountDeletionStatus: vi.fn(),
}))
vi.mock('@/lib/trip/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trip/api')>()
  return { ...actual, requestAccountDeletion, cancelAccountDeletion, getAccountDeletionStatus }
})

import DeleteAccountCard from '@/components/settings/DeleteAccountCard'
import { ApiError } from '@/lib/trip/api'

const EMAIL = 'traveler@example.com'
const SCHEDULE = '2026-08-11T09:00:00.000Z'

beforeEach(() => {
  useUser.mockReturnValue({ user: { id: 'u1', name: 'Traveler', email: EMAIL }, loading: false })
  getAccessToken.mockResolvedValue('jwt-token')
  requestAccountDeletion.mockReset()
  cancelAccountDeletion.mockReset()
  getAccountDeletionStatus.mockReset()
  // Default cross-session read: an active account (no pending deletion). Individual tests override.
  getAccountDeletionStatus.mockResolvedValue({ account_status: 'active', deletion_scheduled_for: null })
})

// The card fires a fire-and-forget status read on mount; for synchronous assertions, flush that
// microtask chain inside act so its (benign, active) setState doesn't warn after the test body.
async function flushMountStatusRead() {
  await act(async () => {})
}

describe('DeleteAccountCard — type-to-confirm', () => {
  it('keeps the confirm button disabled until the typed value EXACTLY matches the account email', async () => {
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
    await flushMountStatusRead()
  })

  it('also enables confirm when the literal word DELETE is typed', async () => {
    render(<DeleteAccountCard />)
    fireEvent.click(screen.getByRole('button', { name: /^delete account$/i }))
    const confirm = screen.getByRole('button', { name: /confirm deletion/i })

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'DELETE' } })
    expect(confirm).toBeEnabled()
    await flushMountStatusRead()
  })

  it('does not enable confirm on an empty field even if the email has not loaded', async () => {
    useUser.mockReturnValue({ user: null, loading: true })
    render(<DeleteAccountCard />)
    fireEvent.click(screen.getByRole('button', { name: /^delete account$/i }))
    // Empty confirmText must never match an empty email.
    expect(screen.getByRole('button', { name: /confirm deletion/i })).toBeDisabled()
    await flushMountStatusRead()
  })
})

describe('DeleteAccountCard — request', () => {
  it('calls requestAccountDeletion on confirm and renders the returned scheduled date', async () => {
    requestAccountDeletion.mockResolvedValue({ scheduled_for: SCHEDULE })
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

describe('DeleteAccountCard — cross-session status seed', () => {
  it('seeds the pending banner + an enabled Cancel from the on-mount status read', async () => {
    getAccountDeletionStatus.mockResolvedValue({
      account_status: 'pending_deletion',
      deletion_scheduled_for: SCHEDULE,
    })
    render(<DeleteAccountCard />)

    // The banner appears WITHOUT an in-session request — purely from the fetched status.
    expect(await screen.findByText(/august 11, 2026/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel deletion/i })).toBeEnabled()
    // No in-session request was needed to reach the pending state.
    expect(requestAccountDeletion).not.toHaveBeenCalled()
  })

  it('seeds the locked in-progress state (Cancel disabled) when the account is already deleting', async () => {
    getAccountDeletionStatus.mockResolvedValue({
      account_status: 'deleting',
      deletion_scheduled_for: null,
    })
    render(<DeleteAccountCard />)

    expect(await screen.findByText(/no longer be cancelled/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel deletion/i })).toBeDisabled()
  })

  it('does not setState after unmount when the status read resolves late (unmount guard)', async () => {
    // React 19 no-ops a setState on an unmounted component, so the guard is a leak-safety measure;
    // this asserts a late-resolving read after unmount surfaces no warning/leak.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    getAccountDeletionStatus.mockResolvedValue({
      account_status: 'pending_deletion',
      deletion_scheduled_for: SCHEDULE,
    })
    const { unmount } = render(<DeleteAccountCard />)
    unmount() // unmount before the on-mount status read resolves
    // Flush the getAccessToken → getAccountDeletionStatus microtask chain.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('DeleteAccountCard — pending banner + cancel', () => {
  beforeEach(() => {
    getAccountDeletionStatus.mockResolvedValue({
      account_status: 'pending_deletion',
      deletion_scheduled_for: SCHEDULE,
    })
  })

  it('calls cancelAccountDeletion and returns to the delete control on success', async () => {
    cancelAccountDeletion.mockResolvedValue({ cancelled: true })
    render(<DeleteAccountCard />)

    fireEvent.click(await screen.findByRole('button', { name: /cancel deletion/i }))
    await waitFor(() => expect(cancelAccountDeletion).toHaveBeenCalledWith('jwt-token'))
    expect(await screen.findByRole('button', { name: /^delete account$/i })).toBeInTheDocument()
  })

  it('shows the in-progress message and disables Cancel on a deletion_already_started response', async () => {
    cancelAccountDeletion.mockRejectedValue(new ApiError(409, 'deletion_already_started', 'started'))
    render(<DeleteAccountCard />)

    fireEvent.click(await screen.findByRole('button', { name: /cancel deletion/i }))
    await waitFor(() => expect(cancelAccountDeletion).toHaveBeenCalledWith('jwt-token'))
    expect(await screen.findByText(/no longer be cancelled/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel deletion/i })).toBeDisabled()
  })

  it('shows a brief neutral note (not a silent revert) on a no_pending_deletion cancel', async () => {
    cancelAccountDeletion.mockRejectedValue(new ApiError(409, 'no_pending_deletion', 'nothing'))
    render(<DeleteAccountCard />)

    fireEvent.click(await screen.findByRole('button', { name: /cancel deletion/i }))
    // Returns to the delete control…
    expect(await screen.findByRole('button', { name: /^delete account$/i })).toBeInTheDocument()
    // …but not silently — a neutral note explains why the banner disappeared.
    expect(screen.getByText(/isn.t scheduled for deletion/i)).toBeInTheDocument()
  })
})
