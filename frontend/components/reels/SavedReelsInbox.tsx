'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import SignOutButton from '@/components/auth/SignOutButton'
import type { SavedReelCard } from '@/lib/reels/backend-types'

const MAX_SELECTED = 5

export default function SavedReelsInbox({
  cards, onCapture, onOrganize,
}: {
  cards: SavedReelCard[]
  onCapture: (url: string) => Promise<void>
  onOrganize: (ids: string[]) => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    return () => { activeRef.current = false }
  }, [])

  async function capture() {
    if (!url.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      await onCapture(url.trim())
      if (!activeRef.current) return
      setUrl('')
      setMessage('Saved to your inbox.')
    } catch (error) {
      if (!activeRef.current) return
      setMessage(error instanceof Error ? error.message : 'Could not save that Reel.')
    } finally {
      if (activeRef.current) setBusy(false)
    }
  }

  function toggle(id: string) {
    setSelected((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : current.length < MAX_SELECTED ? [...current, id] : current)
  }

  async function organize() {
    if (!selected.length) return
    setBusy(true)
    setMessage(null)
    try {
      await onOrganize(selected)
    } catch (error) {
      if (!activeRef.current) return
      setMessage(error instanceof Error ? error.message : 'Could not organize those Reels.')
      if (activeRef.current) setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-4xl flex-col gap-8 bg-[var(--void)] p-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="type-display text-3xl text-[var(--starlight)]">Saved Reels</h1>
            <p className="type-body mt-1 text-sm text-[var(--muted)]">Your inspiration inbox, ready to turn into a route.</p>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/app/trips" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)] underline-offset-2 hover:underline">My trips</Link>
            <SignOutButton />
          </div>
        </div>
      </header>

      <section className="surface flex flex-col gap-3 p-4">
        <label htmlFor="saved-reel-url" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">Save an Instagram Reel</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input id="saved-reel-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.instagram.com/reel/..." className="surface type-body min-h-11 flex-1 rounded-lg p-3 text-sm text-[var(--starlight)] placeholder:text-[var(--faint)]" />
          <button type="button" onClick={capture} disabled={busy || !url.trim()} className="type-label min-h-11 rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-4 text-xs uppercase tracking-wide text-[var(--starlight)] disabled:cursor-not-allowed disabled:opacity-40">Save Reel</button>
        </div>
        {message ? <p role="status" className="type-body text-xs text-[var(--muted)]">{message}</p> : null}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="type-display text-xl text-[var(--starlight)]">Inbox</h2>
            <p className="type-body text-xs text-[var(--faint)]">Save first, analyze only when you are ready to organize.</p>
          </div>
          {!selectionMode ? (
            <button type="button" onClick={() => setSelectionMode(true)} className="type-label min-h-11 rounded-lg border border-[var(--line)] px-4 text-xs uppercase tracking-wide text-[var(--muted)] hover:text-[var(--starlight)]">Select Reels to organize</button>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="type-label text-[10px] uppercase tracking-wide text-[var(--muted)]">{selected.length} / {MAX_SELECTED} selected</span>
              <button type="button" onClick={() => { setSelectionMode(false); setSelected([]) }} className="type-label min-h-11 rounded-lg px-3 text-xs uppercase tracking-wide text-[var(--faint)]">Cancel</button>
              <button type="button" onClick={organize} disabled={busy || !selected.length} className="type-label min-h-11 rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-4 text-xs uppercase tracking-wide text-[var(--starlight)] disabled:cursor-not-allowed disabled:opacity-40">Organize selected</button>
            </div>
          )}
        </div>
        {selectionMode ? <p className="type-body text-xs text-[var(--faint)]">Up to five Reels per organize. Cached Reels are free; only uncached Reels use analysis quota.</p> : null}

        {cards.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {cards.map((card) => {
              const cached = card.has_current_cache
              return (
                <li key={card.id} className="surface flex min-h-36 gap-3 p-3">
                  {selectionMode ? <input type="checkbox" aria-label={`Select ${card.normalized_url}`} checked={selected.includes(card.id)} onChange={() => toggle(card.id)} className="mt-1 h-5 w-5 shrink-0 accent-[var(--brass)]" /> : null}
                  {card.thumbnail_url ? <img src={card.thumbnail_url} alt="" className="h-20 w-20 shrink-0 rounded-lg object-cover" /> : <div aria-hidden className="h-20 w-20 shrink-0 rounded-lg bg-[var(--chip-bg)]" />}
                  <div className="min-w-0 flex-1">
                    <p className="type-evidence truncate text-xs text-[var(--faint)]">{card.normalized_url}</p>
                    <p className="type-body mt-2 line-clamp-2 text-sm text-[var(--starlight)]">{card.caption ?? 'Caption will appear after safe Reel analysis.'}</p>
                    <span className="type-label mt-3 inline-flex rounded-[var(--radius-chip)] bg-[rgba(247,243,232,0.08)] px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">{cached ? 'Cache ready' : 'Not analyzed yet'}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : <p className="type-body text-sm text-[var(--faint)]">No saved Reels yet. Paste one above to start your inbox.</p>}
      </section>
    </main>
  )
}
