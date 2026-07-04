import { describe, it, expect } from 'vitest'
import {
  EMPTY_DRAFT, TRAVEL_STYLE_OPTIONS, INTEREST_OPTIONS, STEPS,
  toggleTag, canFinish, toProfileInput, type OnboardingDraft,
} from '@/lib/onboarding/onboarding'

describe('toggleTag', () => {
  it('adds a tag when absent and removes it when present', () => {
    expect(toggleTag([], 'a')).toEqual(['a'])
    expect(toggleTag(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('canFinish', () => {
  it('is false with no style and no interest tags', () => {
    expect(canFinish(EMPTY_DRAFT)).toBe(false)
  })
  it('is true once a style OR interest tag is chosen', () => {
    expect(canFinish({ ...EMPTY_DRAFT, travel_style_tags: ['food-led'] })).toBe(true)
    expect(canFinish({ ...EMPTY_DRAFT, preference_tags: ['ramen'] })).toBe(true)
  })
})

describe('toProfileInput', () => {
  it('trims blank origin/notes to null and passes tags through', () => {
    const draft: OnboardingDraft = {
      origin_city: '  ', travel_style_tags: ['relaxed'], preference_tags: ['coffee'], preference_notes: '  ',
    }
    expect(toProfileInput(draft)).toEqual({
      origin_city: null, travel_style_tags: ['relaxed'], preference_tags: ['coffee'], preference_notes: null,
    })
  })
  it('keeps trimmed origin and notes', () => {
    const draft: OnboardingDraft = {
      origin_city: ' Tokyo ', travel_style_tags: [], preference_tags: [], preference_notes: ' avoid rushing ',
    }
    const out = toProfileInput(draft)
    expect(out.origin_city).toBe('Tokyo')
    expect(out.preference_notes).toBe('avoid rushing')
  })
})

describe('vocabularies + steps', () => {
  it('exposes non-empty option lists and a 5-step flow ending in review', () => {
    expect(TRAVEL_STYLE_OPTIONS.length).toBeGreaterThan(0)
    expect(INTEREST_OPTIONS.length).toBeGreaterThan(0)
    expect(STEPS.length).toBe(5)
    expect(STEPS[STEPS.length - 1].key).toBe('review')
  })
})
