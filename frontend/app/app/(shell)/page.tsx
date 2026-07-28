import { MOCK_AUTH_ENABLED } from '@/lib/auth/mock-auth'
import CreateTripFlow from '@/components/create/CreateTripFlow'
import SavedReelsFlow from '@/components/reels/SavedReelsFlow'

export default function AppHomePage() {
  return MOCK_AUTH_ENABLED ? <CreateTripFlow /> : <SavedReelsFlow />
}
