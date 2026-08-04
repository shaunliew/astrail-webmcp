import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DEMO_PROFILE, DEMO_MEMORY_FACTS } from '@/lib/trip/fixtures'

// Profile + remembered facts now come from the live reads (Supabase profile row + mem0
// backend via getMemoryPreferences), never the mock. clearMemory still rides mock-api.
const { getProfile, getMemoryPreferences } = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getMemoryPreferences: vi.fn(),
}))
vi.mock('@/lib/trip/supabase-api', () => ({ getProfile, getMemoryPreferences }))

const { clearMemory } = vi.hoisted(() => ({
  clearMemory: vi.fn(async () => ({ ok: true as const })),
}))
vi.mock('@/lib/trip/mock-api', () => ({ clearMemory }))

import SettingsView from '@/components/settings/SettingsView'

describe('SettingsView', () => {
  beforeEach(() => {
    getProfile.mockResolvedValue({ profile: DEMO_PROFILE, facts: [] })
    getMemoryPreferences.mockResolvedValue({ status: 'ok', facts: DEMO_MEMORY_FACTS })
    clearMemory.mockClear()
  })

  it('renders the live profile summary and the remembered mem0 memories', async () => {
    render(<SettingsView />)
    // Profile fields come from the live traveler_profiles read, not the mock demo.
    expect(await screen.findByText(/kuala lumpur/i)).toBeInTheDocument()
    expect(screen.getByText(/using your saved travel preferences/i)).toBeInTheDocument()
    // Remembered facts render as mem0 prose (not the old structured receipt lines).
    expect(screen.getByText(DEMO_MEMORY_FACTS[0].memory)).toBeInTheDocument()
    expect(screen.getByText(DEMO_MEMORY_FACTS[1].memory)).toBeInTheDocument()
  })

  it('tags every remembered memory with its Memory provenance and no invented confidence %', async () => {
    render(<SettingsView />)
    await screen.findByText(DEMO_MEMORY_FACTS[0].memory)
    // Every mem0 memory is remembered (not user-stated), so all carry the "Memory" tag.
    expect(screen.getAllByText('Memory')).toHaveLength(DEMO_MEMORY_FACTS.length)
    // mem0 has no confidence score — no fabricated percentage may appear (guardrail #1).
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument()
  })

  it('clears memory and swaps the list for a cleared message', async () => {
    render(<SettingsView />)
    await screen.findByText(DEMO_MEMORY_FACTS[0].memory)
    fireEvent.click(screen.getByRole('button', { name: /clear memory/i }))
    await waitFor(() => expect(clearMemory).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/memory cleared/i)).toBeInTheDocument()
    expect(screen.queryByText(DEMO_MEMORY_FACTS[0].memory)).not.toBeInTheDocument()
  })

  it('shows an empty state when memory is reachable but nothing is saved yet', async () => {
    getMemoryPreferences.mockResolvedValue({ status: 'ok', facts: [] })
    render(<SettingsView />)
    expect(await screen.findByText(/hasn.t remembered anything yet/i)).toBeInTheDocument()
  })

  it('distinguishes a down memory backend from an empty one', async () => {
    getMemoryPreferences.mockResolvedValue({ status: 'unavailable', facts: [] })
    render(<SettingsView />)
    // Profile still renders; only the remembered-facts section degrades.
    expect(await screen.findByText(/kuala lumpur/i)).toBeInTheDocument()
    expect(screen.getByText(/load your saved preferences/i)).toBeInTheDocument()
    expect(screen.queryByText(/hasn.t remembered anything yet/i)).not.toBeInTheDocument()
  })
})
