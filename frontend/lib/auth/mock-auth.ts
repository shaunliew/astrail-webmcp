export const MOCK_AUTH_ENABLED = process.env.NEXT_PUBLIC_MOCK_AUTH === 'true'

export const MOCK_USER = {
  id: 'demo-user',
  name: 'Astronaut',
  email: 'demo@astrail.app',
}

export function getMockSession(): { user: typeof MOCK_USER } | null {
  return MOCK_AUTH_ENABLED ? { user: MOCK_USER } : null
}
