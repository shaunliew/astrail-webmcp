import { describe, it, expect } from 'vitest'
import { tripTitle, tripDateRange, tripStatusLabel, tripStatusTone, statusDotClass, budgetLabel } from '@/lib/trip/trip-presenters'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import type { Trip } from '@/lib/trip/backend-types'

const base: Trip = { ...TOKYO_TRIP.trip }

describe('tripTitle', () => {
  it('prefers inferred_destination, falls back to hint then Untitled', () => {
    expect(tripTitle({ ...base, inferred_destination: 'Tokyo, Japan' })).toBe('Tokyo, Japan')
    expect(tripTitle({ ...base, inferred_destination: null, destination_hint: 'Tokyo' })).toBe('Tokyo')
    expect(tripTitle({ ...base, inferred_destination: null, destination_hint: null })).toBe('Untitled trip')
  })
})

describe('tripDateRange', () => {
  it('formats a start–end range, a lone start, or a flexible fallback', () => {
    const range = tripDateRange({ ...base, start_date: '2026-08-14', end_date: '2026-08-16' })
    expect(range).toMatch(/14/)
    expect(range).toMatch(/16/)
    expect(tripDateRange({ ...base, start_date: '2026-08-14', end_date: null })).toMatch(/14/)
    expect(tripDateRange({ ...base, start_date: null, end_date: null })).toBe('Dates flexible')
  })
})

describe('tripStatusLabel', () => {
  it('maps statuses to human labels', () => {
    expect(tripStatusLabel('saved_with_gaps')).toBe('Saved with gaps')
    expect(tripStatusLabel('complete')).toBe('Complete')
  })

  it('maps statuses to tones — only in-flight states animate', () => {
    expect(tripStatusTone('generating')).toBe('live')
    expect(tripStatusTone('complete')).toBe('ok')
    expect(tripStatusTone('saved_with_gaps')).toBe('warn')
    expect(tripStatusTone('failed')).toBe('fail')
    expect(statusDotClass('generating')).toBe('pulse-dot pulse-dot--live')
    expect(statusDotClass('saved_with_gaps')).toBe('pulse-dot pulse-dot--warn')
  })
})

describe('budgetLabel', () => {
  it('labels a level or falls back for null', () => {
    expect(budgetLabel('mid_range')).toBe('Mid-range')
    expect(budgetLabel(null)).toBe('Any budget')
  })
})
