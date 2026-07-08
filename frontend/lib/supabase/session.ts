import { createClient } from './client'

export async function getAccessToken(): Promise<string> {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  return session.access_token
}
