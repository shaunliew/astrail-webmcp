import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DEMO_PROFILE, DEMO_PREFERENCE_FACTS } from '@/lib/trip/fixtures'

const { getProfile, clearMemory } = vi.hoisted(() => ({
  getProfile: vi.fn(),
  clearMemory: vi.fn(async () => ({ ok: true as const })),
}))
vi.mock('@/lib/trip/mock-api', () => ({ getProfile, clearMemory }))

import SettingsView from '@/components/settings/SettingsView'

describe('SettingsView', () => {
  beforeEach(() => {
    getProfile.mockResolvedValue({ profile: DEMO_PROFILE, facts: DEMO_PREFERENCE_FACTS })
    clearMemory.mockClear()
  })

  it('renders the profile summary and the memory receipt lines', async () => {
    render(<SettingsView />)
    expect(await screen.findByText('Likes ramen')).toBeInTheDocument()
    expect(screen.getByText('Prefers walkable days')).toBeInTheDocument()
    expect(screen.getByText(/using your saved travel preferences/i)).toBeInTheDocument()
    expect(screen.getByText(/kuala lumpur/i)).toBeInTheDocument()
  })

  it('discloses where each learned fact came from — Memory for inferred, You for stated (G7)', async () => {
    render(<SettingsView />)
    await screen.findByText('Likes ramen')
    // The demo facts mix sources: mem0-inferred facts carry the Memory evidence
    // chip; facts the user stated (onboarding) carry You. Same closed vocabulary
    // as every other provenance surface (EvidenceChip KIND_LABEL).
    expect(screen.getAllByText('Memory').length).toBeGreaterThan(0)
    expect(screen.getAllByText('You').length).toBeGreaterThan(0)
  })

  it('clears memory and swaps the receipt for a cleared message', async () => {
    render(<SettingsView />)
    await screen.findByText('Likes ramen')
    fireEvent.click(screen.getByRole('button', { name: /clear memory/i }))
    await waitFor(() => expect(clearMemory).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/memory cleared/i)).toBeInTheDocument()
    expect(screen.queryByText('Likes ramen')).not.toBeInTheDocument()
  })
})
