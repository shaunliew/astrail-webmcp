import { describe, expect, it } from 'vitest'
import { buildPreferenceDisclosure } from '@/lib/trip/preference-disclosure'

describe('buildPreferenceDisclosure', () => {
  it('prioritizes explicit non-blank preferences', () => {
    expect(buildPreferenceDisclosure('  ramen and walkable days  ', ['likes museums'])).toEqual({
      source: 'explicit',
      summary: 'ramen and walkable days',
      lines: [],
    })
  })

  it('uses non-empty memory facts when preferences are blank', () => {
    expect(buildPreferenceDisclosure('   ', ['likes ramen', 'walkable days'])).toEqual({
      source: 'memory',
      summary: 'Using your saved travel preferences',
      lines: ['likes ramen', 'walkable days'],
    })
  })

  it('uses the inferred default when preferences and memory are unavailable', () => {
    expect(buildPreferenceDisclosure('', null)).toEqual({
      source: 'inferred_default',
      summary: 'Astrail will infer your trip style from the Reels and build a balanced first draft.',
      lines: [],
    })
    expect(buildPreferenceDisclosure('\t\n', [])).toEqual({
      source: 'inferred_default',
      summary: 'Astrail will infer your trip style from the Reels and build a balanced first draft.',
      lines: [],
    })
  })
})
