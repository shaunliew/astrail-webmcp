import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { push, saveProfile } = vi.hoisted(() => ({
  push: vi.fn(),
  saveProfile: vi.fn(async (input: unknown) => ({ id: 'demo-user', ...(input as object), onboarding_completed: true })),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/trip/supabase-api', () => ({ saveProfile }))

import OnboardingWizard from '@/components/onboarding/OnboardingWizard'

describe('OnboardingWizard', () => {
  beforeEach(() => {
    push.mockClear()
    saveProfile.mockClear()
  })

  it('answers origin + pace, saves the profile, and routes to /app', async () => {
    render(<OnboardingWizard />)
    fireEvent.change(screen.getByLabelText(/home city/i), { target: { value: 'Tokyo' } })
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    fireEvent.click(screen.getByRole('button', { name: /balanced/i }))
    fireEvent.click(screen.getByRole('button', { name: /^finish$/i }))

    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1))
    expect(saveProfile).toHaveBeenCalledWith({
      origin_city: 'Tokyo',
      travel_style_tags: ['balanced'],
      preference_tags: [],
      preference_notes: null,
    })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app'))
  })

  it('keeps the origin CTA disabled (stating its blocker) until a city is entered', () => {
    render(<OnboardingWizard />)
    expect(screen.getByRole('button', { name: /waiting for your city/i })).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/home city/i), { target: { value: 'Tokyo' } })
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled()
  })

  it('keeps Finish disabled until a pace is chosen', () => {
    render(<OnboardingWizard />)
    fireEvent.change(screen.getByLabelText(/home city/i), { target: { value: 'Tokyo' } })
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    expect(screen.getByRole('button', { name: /waiting for your pace/i })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /packed/i }))
    expect(screen.getByRole('button', { name: /^finish$/i })).toBeEnabled()
  })

  it('skipping still completes onboarding (empty profile) and routes to /app', async () => {
    render(<OnboardingWizard />)
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }))
    await waitFor(() =>
      expect(saveProfile).toHaveBeenCalledWith({
        origin_city: null,
        travel_style_tags: [],
        preference_tags: [],
        preference_notes: null,
      }),
    )
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app'))
  })

  it('toggles a pace choice aria-pressed on click', () => {
    render(<OnboardingWizard />)
    fireEvent.change(screen.getByLabelText(/home city/i), { target: { value: 'Tokyo' } })
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    const choice = screen.getByRole('button', { name: /relaxed/i })
    expect(choice).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(choice)
    expect(choice).toHaveAttribute('aria-pressed', 'true')
  })
})
