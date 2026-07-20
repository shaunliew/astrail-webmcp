// Night-world shell for every /app route (Night & Daybreak — docs/DESIGN-DRAFT.md).
// The .app-shell scope remaps the design tokens to Night values; the landing at /
// keeps the :root palette untouched.
//
// MapProvider sits here because it is the only common ancestor of the generation scene
// and the trip workspace — the two sides of the router.push handoff that the night->dawn
// relight has to survive. It builds nothing until a route actually asks for a map.
import MapProvider from '@/components/map/MapProvider'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <MapProvider>{children}</MapProvider>
    </div>
  )
}
