export type OnboardingDraft = {
  origin_city: string
  travel_style_tags: string[]
  preference_tags: string[]
  preference_notes: string
}

export type ProfileInput = {
  origin_city: string | null
  travel_style_tags: string[]
  preference_tags: string[]
  preference_notes: string | null
}

export const EMPTY_DRAFT: OnboardingDraft = {
  origin_city: '', travel_style_tags: [], preference_tags: [], preference_notes: '',
}

// Design vocabularies. The PRD leaves these open; they imitate the demo fixture
// (food-led / walkable / relaxed · ramen / walkable days / not too rushed).
// NOTE (schema parity): budget/pace are captured here as free-form travel-style tags
// (e.g. `budget-conscious`, `fast-paced`) — TravelerProfile has no budget/pace column.
export const TRAVEL_STYLE_OPTIONS = [
  'food-led', 'walkable', 'relaxed', 'fast-paced', 'adventure',
  'culture', 'nature', 'nightlife', 'luxury', 'budget-conscious',
] as const

export const INTEREST_OPTIONS = [
  'ramen', 'street food', 'coffee', 'museums', 'temples',
  'shopping', 'hiking', 'beaches', 'photography', 'markets',
] as const

export const STEPS = [
  { key: 'origin', title: 'Where do you begin?' },
  { key: 'style', title: 'Your travel style' },
  { key: 'interests', title: 'What are you into?' },
  { key: 'notes', title: 'Anything to remember?' },
  { key: 'review', title: 'Ready for liftoff?' },
] as const

export function toggleTag(tags: string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]
}

export function canFinish(draft: OnboardingDraft): boolean {
  return draft.travel_style_tags.length > 0 || draft.preference_tags.length > 0
}

export function toProfileInput(draft: OnboardingDraft): ProfileInput {
  const clean = (s: string): string | null => {
    const t = s.trim()
    return t.length ? t : null
  }
  return {
    origin_city: clean(draft.origin_city),
    travel_style_tags: draft.travel_style_tags,
    preference_tags: draft.preference_tags,
    preference_notes: clean(draft.preference_notes),
  }
}
