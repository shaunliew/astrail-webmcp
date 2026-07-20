// Global 404 — only a root not-found.tsx catches unmatched URLs.
// Middleware guards /app/* only, so the one action must be safe signed-out: home.
import Link from 'next/link'
import Astronaut from '@/components/mascot/Astronaut'

export default function NotFound() {
  return (
    <main className="app-shell flex min-h-[100dvh] flex-col items-center justify-center gap-4 p-6 text-center">
      <Astronaut size={48} />
      <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">404</span>
      <h1 className="type-display text-3xl text-[var(--starlight)]">Off the trail</h1>
      <p className="type-body max-w-sm text-sm text-[var(--muted)]">
        There&apos;s nothing mapped at this address.
      </p>
      <Link
        href="/"
        className="type-label mt-2 rounded-lg border border-[var(--brass)] bg-[var(--brass-glow)] px-4 py-3 text-sm uppercase tracking-wide text-[var(--starlight)] transition-colors hover:bg-[rgba(201,151,78,0.38)]"
      >
        Back to Astrail
      </Link>
    </main>
  )
}
