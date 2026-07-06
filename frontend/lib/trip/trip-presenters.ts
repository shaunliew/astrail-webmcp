import type { Trip, TripStatus, BudgetLevel } from '@/lib/trip/backend-types'

export function tripTitle(trip: Trip): string {
  return trip.inferred_destination ?? trip.destination_hint ?? 'Untitled trip'
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function tripDateRange(trip: Trip): string {
  if (trip.start_date && trip.end_date) return `${shortDate(trip.start_date)} – ${shortDate(trip.end_date)}`
  if (trip.start_date) return shortDate(trip.start_date)
  return 'Dates flexible'
}

const STATUS_LABEL: Record<TripStatus, string> = {
  draft: 'Draft',
  generating: 'Generating',
  places_ready: 'Places ready',
  complete: 'Complete',
  saved_with_gaps: 'Saved with gaps',
  failed: 'Failed',
}

export function tripStatusLabel(status: TripStatus): string {
  return STATUS_LABEL[status]
}

const BUDGET_LABEL: Record<BudgetLevel, string> = {
  budget: 'Budget',
  mid_range: 'Mid-range',
  premium: 'Premium',
  luxury: 'Luxury',
}

export function budgetLabel(budget: BudgetLevel | null): string {
  return budget ? BUDGET_LABEL[budget] : 'Any budget'
}
