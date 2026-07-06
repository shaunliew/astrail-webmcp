import type { UserPreferenceFact } from '@/lib/trip/backend-types'

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
