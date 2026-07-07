// RLS-direct Supabase reads/writes (architecture: most reads skip the backend).
// Replaces mock-api for the real app; mock-api stays for offline shell/tests only.
import { createClient } from '@/lib/supabase/client'
import type { ProfileInput } from '@/lib/onboarding/onboarding'
import type { TravelerProfile } from '@/lib/trip/backend-types'

export async function saveProfile(input: ProfileInput): Promise<TravelerProfile> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  // Upsert: the profile row may not exist yet (no auto-create trigger for traveler_profiles).
  const { data, error } = await supabase
    .from('traveler_profiles')
    .upsert({ id: user.id, ...input, onboarding_completed: true })
    .select('id,origin_city,travel_style_tags,preference_tags,preference_notes,onboarding_completed')
    .single()
  if (error) throw new Error(`Could not save your preferences: ${error.message}`)
  return data as TravelerProfile
}
