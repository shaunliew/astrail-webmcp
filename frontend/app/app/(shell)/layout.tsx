// Full-bleed paper shell for the /app routes that are NOT map screens (dashboard,
// trails, settings). One connected surface — the persistent sidebar rail + a scrolling
// main, split by a single hairline divider, no gap and no outer frame — so the app reads
// edge-to-edge, consistent with the full-bleed map screens (trip, generation) and
// onboarding that stay outside this group. Nested inside app/app/layout.tsx (.app-shell +
// MapProvider); paints its own paper surface over the app-shell background.
//
// The main is padded + scrolls by default (the document pages: home, settings). A page
// that wants the whole area edge-to-edge — the /app/trips three-pane, which lets the shared
// fixed map show through a right-hand window — opts out by rendering a `[data-fullbleed]`
// child: the `has-[…]` variants drop the padding and hand scroll control to the page. This
// is scoped to that page only; the document pages never carry the attribute.
import Sidebar from '@/components/dashboard/Sidebar'

export default function DocumentShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-[color:var(--bg)] sm:h-[100dvh] sm:flex-row">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto bg-[color:var(--surface-0)] px-5 py-6 text-[color:var(--text)] sm:px-8 has-[[data-fullbleed]]:overflow-hidden has-[[data-fullbleed]]:p-0">
        {children}
      </main>
    </div>
  )
}
