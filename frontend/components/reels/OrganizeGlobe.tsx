'use client'

export default function OrganizeGlobe({ message }: { message: string }) {
  return (
    <main data-testid="organize-globe" className="relative flex min-h-[100dvh] items-center overflow-hidden bg-[var(--void)] p-6">
      <div aria-hidden className="hero-field absolute inset-0 opacity-60" />
      <div className="relative z-10 mx-auto w-full max-w-lg">
        <div className="surface flex flex-col gap-4 p-6">
          <p className="type-label text-[10px] uppercase tracking-[0.2em] text-[var(--brass-bright)]">Organizing your sky</p>
          <h1 className="type-display text-3xl text-[var(--starlight)]">Finding the places inside your Reels</h1>
          <div role="status" className="type-body rounded-lg border border-[rgba(201,151,78,0.3)] bg-[var(--brass-soft)] px-3 py-3 text-sm text-[var(--starlight)]">{message}</div>
        </div>
      </div>
    </main>
  )
}
