import { describe, it, expect } from 'vitest'
import { DEMO_PROFILE, DEMO_PREFERENCE_FACTS } from '@/lib/trip/fixtures/traveler'

describe('traveler fixture', () => {
  it('has a completed onboarding profile', () => {
    expect(DEMO_PROFILE.id).toBe('demo-user')
    expect(DEMO_PROFILE.onboarding_completed).toBe(true)
    expect(DEMO_PROFILE.preference_tags.length).toBeGreaterThan(0)
  })
  it('has active preference facts for the memory receipt', () => {
    expect(DEMO_PREFERENCE_FACTS.every((f) => f.status === 'active')).toBe(true)
    expect(DEMO_PREFERENCE_FACTS.length).toBeGreaterThanOrEqual(3)
  })
})
