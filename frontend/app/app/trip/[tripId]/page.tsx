// /app/trip/[tripId] — trip detail + map view
export default async function TripPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  await params;
  return <main />;
}
