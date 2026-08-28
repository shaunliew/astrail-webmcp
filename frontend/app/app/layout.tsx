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
import AgentConfirm from '@/components/webmcp/AgentConfirm'
import WebMcpDock from '@/components/webmcp/WebMcpDock'
import GenerationProvider from '@/components/generation/GenerationProvider'

// The WebMCP layer sits beside MapProvider for the same reason MapProvider is here: the shell is
// the only common ancestor of every /app route, so a tool registered here survives client-side
// navigation while a tool registered on a page correctly disappears with it.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <WebMcpRegistryProvider>
        {/* Inside MapProvider, above GlobalTools: both sides of a generation need the run - the
            tool that starts it and the page that renders it - and the shell owns the night->dawn
            relight that marks a finished trip. A run owned by a page dies when that page unmounts,
            which is why an agent-started trip never reached the screen at all. */}
        <MapProvider>
          <GenerationProvider>
            {children}
            <GlobalTools />
            <AgentConfirm />
            <WebMcpDock />
          </GenerationProvider>
        </MapProvider>
      </WebMcpRegistryProvider>
    </div>
  )
}
