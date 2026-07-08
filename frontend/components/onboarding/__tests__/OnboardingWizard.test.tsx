import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { push, saveProfile } = vi.hoisted(() => ({
  push: vi.fn(),
  saveProfile: vi.fn(async (input: unknown) => ({ id: 'demo-user', ...(input as object), onboarding_completed: true })),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/trip/supabase-api', () => ({ saveProfile }))

import OnboardingWizard from '@/components/onboarding/OnboardingWizard'

const clickNext = () => fireEvent.click(screen.getByRole('button', { name: /^next$/i }))

describe('OnboardingWizard', () => {
  beforeEach(() => { push.mockClear(); saveProfile.mockClear() })

  it('walks the steps, saves the profile, and routes to /app', async () => {
    render(<OnboardingWizard />)
    fireEvent.change(screen.getByLabelText(/origin city/i), { target: { value: 'Tokyo' } })
    clickNext()
    fireEvent.click(screen.getByRole('button', { name: /^food-led$/i }))
    clickNext()
    fireEvent.click(screen.getByRole('button', { name: /^ramen$/i }))
    clickNext()
    fireEvent.change(screen.getByLabelText(/remember/i), { target: { value: 'avoid rushing' } })
    clickNext()
    fireEvent.click(screen.getByRole('button', { name: /finish/i }))

    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1))
    expect(saveProfile).toHaveBeenCalledWith({
      origin_city: 'Tokyo',
      travel_style_tags: ['food-led'],
      preference_tags: ['ramen'],
      preference_notes: 'avoid rushing',
    })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app'))
  })

  it('disables Finish until at least one style or interest tag is chosen', () => {
    render(<OnboardingWizard />)
    for (let i = 0; i < 4; i++) clickNext() // advance to the review step selecting nothing
    expect(screen.getByRole('button', { name: /finish/i })).toBeDisabled()
  })

  it('toggles a chip aria-pressed on click', () => {
    render(<OnboardingWizard />)
    clickNext() // to the style step
    const chip = screen.getByRole('button', { name: /^food-led$/i })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
  })
})
