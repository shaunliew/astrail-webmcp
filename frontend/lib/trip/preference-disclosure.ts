export type PreferenceDisclosure = {
  source: 'explicit' | 'memory' | 'inferred_default'
  summary: string
  lines: string[]
}

export function buildPreferenceDisclosure(
  preferencesText: string,
  memoryFacts: string[] | null,
): PreferenceDisclosure {
  const explicitPreferences = preferencesText.trim()
  if (explicitPreferences) {
    return { source: 'explicit', summary: explicitPreferences, lines: [] }
  }

  if (memoryFacts && memoryFacts.length > 0) {
    return {
      source: 'memory',
      summary: 'Using your saved travel preferences',
      lines: memoryFacts,
    }
  }

  return {
    source: 'inferred_default',
    summary: 'Astrail will infer your trip style from the Reels and build a balanced first draft.',
    lines: [],
  }
}
