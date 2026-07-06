// /app/trip/[tripId] — trip detail + map view
import TripWorkspace from '@/components/trip/TripWorkspace'

export default async function TripPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params
  return <TripWorkspace tripId={tripId} />
}
