import { describe, it, expect } from 'vitest'
import { factToReceiptLine, memoryReceiptLines } from '@/lib/profile/memory'
import { DEMO_PREFERENCE_FACTS } from '@/lib/trip/fixtures'
import type { UserPreferenceFact } from '@/lib/trip/backend-types'

const mk = (over: Partial<UserPreferenceFact>): UserPreferenceFact => ({
  id: 'x', user_id: 'demo-user', category: 'c', fact_key: 'k', fact_value: 'v',
  source: 'onboarding', confidence: 0.9, status: 'active', ...over,
})

describe('factToReceiptLine', () => {
  it('renders each known fact_key as a human line', () => {
    expect(factToReceiptLine(mk({ fact_key: 'likes_cuisine', fact_value: 'ramen' }))).toBe('Likes ramen')
    expect(factToReceiptLine(mk({ fact_key: 'prefers', fact_value: 'walkable days' }))).toBe('Prefers walkable days')
    expect(factToReceiptLine(mk({ fact_key: 'avoids', fact_value: 'rushed itineraries' }))).toBe('Avoids rushed itineraries')
    expect(factToReceiptLine(mk({ fact_key: 'style', fact_value: 'mid_range' }))).toBe('Budget style: mid-range')
  })
})

describe('memoryReceiptLines', () => {
  it('renders one line per active demo fact', () => {
    expect(memoryReceiptLines(DEMO_PREFERENCE_FACTS)).toEqual([
      'Likes ramen', 'Prefers walkable days', 'Avoids rushed itineraries', 'Budget style: mid-range',
    ])
  })
  it('drops non-active facts', () => {
    const facts = [
      mk({ fact_key: 'likes_cuisine', fact_value: 'ramen' }),
      mk({ status: 'deleted', fact_key: 'avoids', fact_value: 'crowds' }),
    ]
    expect(memoryReceiptLines(facts)).toEqual(['Likes ramen'])
  })
})
