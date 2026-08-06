import type { MemoryFact, TravelerProfile, UserPreferenceFact } from '@/lib/trip/backend-types'

export const DEMO_PROFILE: TravelerProfile = {
  id: 'demo-user',
  origin_city: 'Kuala Lumpur',
  travel_style_tags: ['food-led', 'walkable', 'relaxed'],
  preference_tags: ['ramen', 'walkable days', 'not too rushed'],
  preference_notes: 'Mid-range budget, avoids rushed itineraries.',
  onboarding_completed: true,
}

const fact = (
  id: string, category: string, fact_key: string, fact_value: unknown,
  source: UserPreferenceFact['source'] = 'onboarding', confidence = 0.9,
): UserPreferenceFact => ({
  id, user_id: 'demo-user', category, fact_key, fact_value,
  source, confidence, status: 'active',
})

// Mixed sources on purpose: the settings receipt discloses stated vs inferred
// (DESIGN.md G7), so the demo needs at least one mem0-inferred fact.
export const DEMO_PREFERENCE_FACTS: UserPreferenceFact[] = [
  fact('pf_1', 'food', 'likes_cuisine', 'ramen'),
  fact('pf_2', 'pace', 'prefers', 'walkable days', 'mem0', 0.8),
  fact('pf_3', 'pace', 'avoids', 'rushed itineraries', 'mem0', 0.74),
  fact('pf_4', 'budget', 'style', 'mid_range'),
]

// Offline-shell stand-in for GET /settings/preferences (mem0 STORED memories). Prose,
// not structured facts — mem0 returns sentences, and `created_at` is a fixed literal so
// the mock stays deterministic (no wall-clock in the offline shell).
export const DEMO_MEMORY_FACTS: MemoryFact[] = [
  { id: 'mem_1', memory: 'Prefers walkable, food-led days over packed sightseeing', created_at: '2026-01-01T00:00:00Z', source: 'mem0' },
  { id: 'mem_2', memory: 'Loves ramen and casual local spots', created_at: '2026-01-01T00:00:00Z', source: 'mem0' },
  { id: 'mem_3', memory: 'Avoids rushed itineraries; keeps a mid-range budget', created_at: '2026-01-01T00:00:00Z', source: 'mem0' },
]
