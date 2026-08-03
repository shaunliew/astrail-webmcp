import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'

// PlanSheet is presentational: it renders whatever `gateSlot` node it is handed and knows
// nothing about entitlements. Mock its two side-effecting deps (the map + the profile read).
vi.mock('../VerifiedPlacesMap', () => ({ default: () => <div data-testid="places-map" /> }))
vi.mock('@/lib/trip/supabase-api', () => ({
  getProfile: vi.fn(async () => ({ profile: {}, facts: [] })),
}))

import PlanSheet from '@/components/reels/PlanSheet'
import type { BriefInput } from '@/lib/trip/parse-inspiration'

const EMPTY_BRIEF: BriefInput = {
  destination_hint: '', start_date: '', end_date: '', origin_city: '', budget_level: '', preferences: '',
}

function renderSheet(extra: { gateSlot?: React.ReactNode } = {}) {
  return render(
    <PlanSheet
      places={[]}
      reelCount={0}
      brief={EMPTY_BRIEF}
      onBrief={vi.fn()}
      onBack={vi.fn()}
      onGenerate={vi.fn()}
      error={null}
      {...extra}
    />,
  )
}

describe('PlanSheet (presentational gate slot)', () => {
  it('renders the Generate affordance when no gateSlot is passed', () => {
    renderSheet()
    expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument()
    expect(screen.queryByTestId('gate-node')).not.toBeInTheDocument()
  })

  it('renders whatever node it is handed in place of Generate, knowing nothing about it', () => {
    renderSheet({ gateSlot: <div data-testid="gate-node">gated</div> })
    expect(screen.getByTestId('gate-node')).toBeInTheDocument()
    // The Generate button (and its "Add your dates to generate" disabled variant) is gone.
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument()
  })

  it('imports no entitlement logic — the gate decision lives in the flow, not the sheet', () => {
    // vitest runs from the frontend/ root, so resolve the source off cwd. Assert on the
    // actual import + hook-call (a doc comment may still name the concept).
    const source = readFileSync(resolve(process.cwd(), 'components/reels/PlanSheet.tsx'), 'utf8')
    expect(source).not.toMatch(/from ['"]@\/lib\/entitlement['"]/)
    expect(source).not.toMatch(/useEntitlement\s*\(/)
  })
})
