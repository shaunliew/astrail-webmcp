import type { TripPlaceEvidence, UserPreferenceFact } from '@/lib/trip/backend-types'

// Turn a structured preference fact into a human "Astrail learned" receipt line.
export function factToReceiptLine(fact: UserPreferenceFact): string {
  const value = String(fact.fact_value).replace(/_/g, '-')
  switch (fact.fact_key) {
    case 'likes_cuisine': return `Likes ${value}`
    case 'prefers': return `Prefers ${value}`
    case 'avoids': return `Avoids ${value}`
    case 'style': return `Budget style: ${value}`
    default: return `${fact.fact_key.replace(/_/g, ' ')}: ${value}`
  }
}

export function memoryReceiptLines(facts: UserPreferenceFact[]): string[] {
  return facts.filter((f) => f.status === 'active').map(factToReceiptLine)
}

// Disclosure is a feature (DESIGN.md SS8): a learned fact renders with its provenance.
// Facts the user stated map to requested_by_you; facts Astrail inferred map to
// memory_preference — the same closed EvidenceKind vocabulary every other surface uses.
const STATED_SOURCES: ReadonlySet<UserPreferenceFact['source']> = new Set([
  'onboarding', 'explicit_input', 'manual',
])

export function factEvidence(fact: UserPreferenceFact): TripPlaceEvidence {
  return {
    confidence: fact.confidence,
    source_url: null,
    quote: null,
    quotes: [],
    rationale: null,
    evidence_kind: STATED_SOURCES.has(fact.source) ? 'requested_by_you' : 'memory_preference',
  }
}

export type MemoryReceiptEntry = { id: string; line: string; evidence: TripPlaceEvidence }

export function memoryReceipt(facts: UserPreferenceFact[]): MemoryReceiptEntry[] {
  return facts
    .filter((f) => f.status === 'active')
    .map((f) => ({ id: f.id, line: factToReceiptLine(f), evidence: factEvidence(f) }))
}
