export const MOCK_AUTH_ENABLED = process.env.NEXT_PUBLIC_MOCK_AUTH === 'true'

// Mock only. The real Supabase user id is a UUID — never hard-code 'demo-user' into a query that outlives the mock.
export const MOCK_USER = {
  id: 'demo-user',
  name: 'Astronaut',
  email: 'demo@astrail.app',
}

export function getMockSession(): { user: typeof MOCK_USER } | null {
  return MOCK_AUTH_ENABLED ? { user: MOCK_USER } : null
}
