// /app/trip/demo — a read-only sample trail.
//
// The submission's claim is that a backend MCP server can return JSON about a trip, but only
// WebMCP can move the 3D map the human is looking at. Seeing that used to cost a sign-in and a
// 60-180s generation, which also made the demo account a single point of failure on the day.
// This route renders the same workspace from a fixture: no account, no generation, nothing spent.
//
// A static segment wins over the sibling `[tripId]` route, so this never reaches Supabase for a
// trip called "demo". `readOnly` is what keeps the write tools off a bundle with no row behind it.
import type { Metadata } from 'next'
import TripWorkspace from '@/components/trip/TripWorkspace'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

export const metadata: Metadata = {
  title: 'Sample trail · Astrail',
  description: 'A finished Astrail trail on a live 3D map — read-only, no account needed.',
}

export default function DemoTripPage() {
  return <TripWorkspace tripId={TOKYO_TRIP.trip.id} bundle={TOKYO_TRIP} readOnly />
}
