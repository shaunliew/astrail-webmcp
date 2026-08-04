import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DEMO_PROFILE, DEMO_MEMORY_FACTS } from '@/lib/trip/fixtures'

// Live reads SettingsView makes on mount — stubbed so the shell renders with real data.
const { getProfile, getMemoryPreferences } = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getMemoryPreferences: vi.fn(),
}))
vi.mock('@/lib/trip/supabase-api', () => ({ getProfile, getMemoryPreferences }))

// DeleteAccountCard reads the account email via useUser once it mounts (flag on only).
const { useUser } = vi.hoisted(() => ({ useUser: vi.fn() }))
vi.mock('@/lib/auth/use-user', () => ({ useUser }))

import SettingsView from '@/components/settings/SettingsView'

describe('SettingsView — self-serve deletion flag gate', () => {
  beforeEach(() => {
    getProfile.mockResolvedValue({ profile: DEMO_PROFILE, facts: [] })
    getMemoryPreferences.mockResolvedValue({ status: 'ok', facts: DEMO_MEMORY_FACTS })
    useUser.mockReturnValue({ user: { id: 'u1', name: 'Traveler', email: 'traveler@example.com' }, loading: false })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does NOT render the delete control when NEXT_PUBLIC_DELETION_ENABLED is off (default build)', async () => {
    vi.stubEnv('NEXT_PUBLIC_DELETION_ENABLED', undefined)
    render(<SettingsView />)
    // The rest of Settings renders…
    expect(await screen.findByText(/using your saved travel preferences/i)).toBeInTheDocument()
    // …but the self-serve delete control is hidden.
    expect(screen.queryByRole('button', { name: /^delete account$/i })).not.toBeInTheDocument()
  })

  it('renders the delete control when NEXT_PUBLIC_DELETION_ENABLED is "true"', async () => {
    vi.stubEnv('NEXT_PUBLIC_DELETION_ENABLED', 'true')
    render(<SettingsView />)
    expect(await screen.findByRole('button', { name: /^delete account$/i })).toBeInTheDocument()
  })
})
