// Paper document shell for the /app routes that are NOT full-bleed map screens
// (dashboard, trails, settings). A framed paper container holding the persistent
// sidebar + a scrolling main. Map screens (trip, generation) and onboarding stay
// outside this group, full-bleed. Nested inside app/app/layout.tsx (.app-shell +
// MapProvider); paints its own paper surface over the app-shell background.
import Sidebar from '@/components/dashboard/Sidebar'

export default function DocumentShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col gap-3 bg-[color:var(--bg)] p-3 md:h-[100dvh] md:flex-row md:gap-3 md:p-5">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-0)] px-5 py-6 text-[color:var(--text)] md:px-8">
        {children}
      </main>
    </div>
  )
}
