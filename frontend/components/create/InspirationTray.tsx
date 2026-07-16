'use client'

import { useState } from 'react'
import type { InspirationStatus } from '@/lib/trip/backend-types'
import {
  buildReelItems, makeRequestedPlace, MAX_REELS,
  type DraftInspirationItem,
} from '@/lib/trip/parse-inspiration'

const STATUS_LABEL: Partial<Record<InspirationStatus, string>> = {
  valid: 'Ready',
  pending_resolution: 'Will confirm',
}

function humanizeStatus(status: InspirationStatus): string {
  return STATUS_LABEL[status] ?? status.replaceAll('_', ' ').toLowerCase()
}

function statusClass(status: InspirationStatus): string {
  if (status === 'valid') return 'bg-[rgba(123,201,166,0.12)] text-[var(--ok)]'
  if (status === 'pending_resolution') return 'bg-[rgba(247,243,232,0.08)] text-[var(--muted)]'
  return 'bg-[rgba(247,243,232,0.05)] text-[var(--faint)]'
}

function reelShortcode(url: string): string {
  const match = url.match(/\/(reel|p|tv)\/([^/]+)\/?$/i)
  return match ? `${match[1].toLowerCase()}/${match[2]}` : url
}

function TypeBadge({ item }: { item: DraftInspirationItem }) {
  const isReel = item.item_type === 'reel_url'
  return (
    <span className="type-label rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--faint)]">
      {isReel ? 'Reel' : 'Requested'}
    </span>
  )
}

function Card({ item, onRemove }: { item: DraftInspirationItem; onRemove: () => void }) {
  const isReel = item.item_type === 'reel_url'
  const primary = isReel ? reelShortcode(item.normalized_reel_url ?? '') : item.requested_place_text
  const removeLabel = isReel ? item.normalized_reel_url : item.requested_place_text
  return (
    <li className="surface flex items-start gap-3 p-3">
      <TypeBadge item={item} />
      <div className="min-w-0 flex-1">
        <span className="type-body block truncate text-sm text-[var(--starlight)]">{primary}</span>
        {isReel ? (
          <span className="type-evidence mt-1 block truncate text-[10px] text-[var(--faint)]">
            {item.normalized_reel_url}
          </span>
        ) : null}
      </div>
      <span className={`type-label shrink-0 rounded-[var(--radius-chip)] px-2 py-1 text-[10px] uppercase tracking-wide ${statusClass(item.status)}`}>
        {humanizeStatus(item.status)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${removeLabel ?? 'item'}`}
        className="type-label rounded-[var(--radius-chip)] border border-transparent px-1.5 py-1 text-[var(--faint)] transition-colors hover:bg-[rgba(247,243,232,0.06)] hover:text-[var(--starlight)]"
      >
        ✕
      </button>
    </li>
  )
}

export default function InspirationTray({
  items, onChange,
}: {
  items: DraftInspirationItem[]
  onChange: (items: DraftInspirationItem[]) => void
}) {
  const [paste, setPaste] = useState('')
  const [placeText, setPlaceText] = useState('')
  const [message, setMessage] = useState('')

  const reelCount = items.filter((i) => i.item_type === 'reel_url').length
  const atMax = reelCount >= MAX_REELS

  function addLinks() {
    const res = buildReelItems(paste, items)
    onChange(res.items)
    setPaste('')
    const parts: string[] = []
    if (res.addedCount) parts.push(`${res.addedCount} link${res.addedCount > 1 ? 's' : ''} added`)
    if (res.duplicateCount) parts.push(`${res.duplicateCount} duplicate`)
    if (res.overCapCount) parts.push(`${res.overCapCount} over the max of ${MAX_REELS}`)
    if (res.invalidCount) parts.push(`${res.invalidCount} not a valid link`)
    setMessage(parts.join(' · ') || 'No Instagram links found.')
  }

  function addPlace() {
    const item = makeRequestedPlace(placeText, items)
    if (item) {
      onChange([...items, item])
      setPlaceText('')
      setMessage('')
    } else {
      setMessage('Enter a new place name.')
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="reel-paste" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
          Paste Instagram Reel links
        </label>
        <textarea
          id="reel-paste"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={3}
          placeholder="https://www.instagram.com/reel/…"
          className="surface type-body rounded-lg p-3 text-sm text-[var(--starlight)] placeholder:text-[var(--faint)]"
        />
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={addLinks}
            className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-3 py-1.5 text-xs uppercase tracking-wide text-[var(--starlight)]"
          >
            Add links
          </button>
          <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">
            {reelCount} / {MAX_REELS} reels
          </span>
        </div>
        {atMax ? (
          <p className="type-label text-[10px] uppercase tracking-wide text-[var(--brass)]">
            Max {MAX_REELS} Reels reached.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="place-input" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
          Add a place you want to visit
        </label>
        <div className="flex gap-2">
          <input
            id="place-input"
            value={placeText}
            onChange={(e) => setPlaceText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPlace() } }}
            placeholder="e.g. Tokyo Disneyland"
            className="surface type-body flex-1 rounded-lg p-2.5 text-sm text-[var(--starlight)] placeholder:text-[var(--faint)]"
          />
          <button
            type="button"
            onClick={addPlace}
            className="type-label rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs uppercase tracking-wide text-[var(--muted)] hover:text-[var(--starlight)]"
          >
            Add place
          </button>
        </div>
      </div>

      {message ? (
        <p className="type-body text-xs text-[var(--muted)]" role="status">{message}</p>
      ) : null}

      {items.length ? (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <Card key={item.key} item={item} onRemove={() => onChange(items.filter((i) => i.key !== item.key))} />
          ))}
        </ul>
      ) : (
        <p className="type-body text-sm text-[var(--faint)]">
          Add at least one Reel link or a place to begin.
        </p>
      )}
    </section>
  )
}
