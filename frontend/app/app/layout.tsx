// Night-world shell for every /app route (Night & Daybreak — docs/DESIGN-DRAFT.md).
// The .app-shell scope remaps the design tokens to Night values; the landing at /
// keeps the :root palette untouched.
//
// MapProvider sits here because it is the only common ancestor of the generation scene
// and the trip workspace — the two sides of the router.push handoff that the night->dawn
// relight has to survive. It builds nothing until a route actually asks for a map.
import MapProvider from '@/components/map/MapProvider'
import { WebMcpRegistryProvider } from '@/components/webmcp/WebMcpRegistry'
import GlobalTools from '@/components/webmcp/GlobalTools'
import WebMcpStatus from '@/components/webmcp/WebMcpStatus'
import AgentConfirm from '@/components/webmcp/AgentConfirm'
import ExamplePrompts from '@/components/webmcp/ExamplePrompts'

// The WebMCP layer sits beside MapProvider for the same reason MapProvider is here: the shell is
// the only common ancestor of every /app route, so a tool registered here survives client-side
// navigation while a tool registered on a page correctly disappears with it.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <WebMcpRegistryProvider>
        <MapProvider>{children}</MapProvider>
        <GlobalTools />
        <AgentConfirm />
        <ExamplePrompts />
        <WebMcpStatus />
      </WebMcpRegistryProvider>
    </div>
  )
}
