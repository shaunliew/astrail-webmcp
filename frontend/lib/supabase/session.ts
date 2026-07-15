import { createClient } from './client'
// Mock-auth shell: no Supabase session exists; api.ts short-circuits to the offline
// fixture before any request could carry this placeholder token.
import { MOCK_AUTH_ENABLED } from '@/lib/auth/mock-auth'

export async function getAccessToken(): Promise<string> {
  if (MOCK_AUTH_ENABLED) return 'mock-session-token'
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  return session.access_token
}
