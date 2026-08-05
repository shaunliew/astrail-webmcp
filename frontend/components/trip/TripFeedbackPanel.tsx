'use client'

import { useRef, useState } from 'react'
import { getAccessToken } from '@/lib/supabase/session'
import { ApiError, submitTripFeedback, type TripFeedbackDraft } from '@/lib/trip/api'
import type { TripFeedback } from '@/lib/trip/backend-types'

/* TripFeedbackPanel — one-shot trip-level feedback composer (plan T2). A mutually-exclusive
   signal (thumbs verdict OR a 1–5 star rating) plus an optional note become ONE POST via
   submitTripFeedback. The backend was designed for "rating a trip is ONE request" (3/min burst
   budget, latest-per-user analytics), so a signal and its note travel in the SAME row — three
   independently-firing controls would burn the budget and confirm contradictory signals.

   Confirmation is built from the persisted 201 row (never the request), so what the user sees
   is what was stored. A ref single-flight guard (not just the disabled attribute) stops a
   same-frame double submit, and a fingerprint of the last successful draft keeps an unchanged
   re-press from inserting a duplicate permanent row (there is no delete endpoint). */

// Mutually-exclusive selection: a thumb verdict, a star rating, or nothing.
type Signal = 'thumbs_up' | 'thumbs_down' | { rating: 1 | 2 | 3 | 4 | 5 }

type Status =
  | { kind: 'idle' }
  | { kind: 'sending'; message: string }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

// Pure, exported, unit-tested directly: the trim/null guard must have its own test separate from
// the Send predicate, or removing either leaves the other green (BUILD-LOOP §7). Returns null when
// there is nothing to send — a bare/whitespace note with no signal. The rating stays typed
// 1|2|3|4|5 (no number widening), which keeps every result assignable to TripFeedbackDraft.
export function buildDraft(signal: Signal | null, note: string): TripFeedbackDraft | null {
  const comment = note.trim()
  if (signal === 'thumbs_up' || signal === 'thumbs_down') {
    return comment ? { feedback_type: signal, comment } : { feedback_type: signal }
  }
  if (signal !== null) {
    return comment
      ? { feedback_type: 'rating', rating: signal.rating, comment }
      : { feedback_type: 'rating', rating: signal.rating }
  }
  return comment ? { feedback_type: 'free_text', comment } : null
}

// Semantic confirmation from the PERSISTED row, not the request (Codex r1 #3). Tests assert this
// text, never class names. " with note" is appended only when the stored row carries a comment.
function confirmedFromRow(row: TripFeedback): string {
  const withNote = row.comment ? ' with note' : ''
  if (row.feedback_type === 'thumbs_up') return `Saved: thumbs up${withNote}`
  if (row.feedback_type === 'thumbs_down') return `Saved: thumbs down${withNote}`
  if (row.feedback_type === 'rating') return `Saved: ${row.rating} of 5${withNote}`
  return 'Saved: note'
}

// One thumb path; the down variant is the same glyph rotated 180° (plan chrome note).
function ThumbIcon({ down }: { down?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={down ? 'rotate-180' : ''}
    >
      <path d="M7 10v10H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3zm0 0 4.5-7a2 2 0 0 1 2 2.4L12.8 9h5.4a2 2 0 0 1 2 2.4l-1.2 6A2 2 0 0 1 17 19H7" />
    </svg>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.77l-5.2 2.74.99-5.79-4.21-4.1 5.82-.85z" />
    </svg>
  )
}

// Thumb pill — brass fill when selected, muted default; mirrors segClass tone in TripWorkspace.
function pillClass(active: boolean): string {
  return [
    'type-label inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-40',
    active
      ? 'border-[var(--brass-bright)] bg-[var(--brass-soft)] text-[var(--brass-bright)]'
      : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--starlight)]',
  ].join(' ')
}

const SEND_BTN =
  'self-start rounded-lg border border-[var(--line)] bg-[var(--brass-soft)] px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--brass-bright)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40'

export default function TripFeedbackPanel({ tripId }: { tripId: string }) {
  const [signal, setSignal] = useState<Signal | null>(null)
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState<string | null>(null)
  // Fingerprint of the last SUCCESSFULLY submitted draft; a matching current draft keeps Send off
  // so an unchanged re-press can't insert an identical permanent row (Codex r2 #1).
  const [lastSent, setLastSent] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  // Synchronous single-flight guard: the `pending` state only styles/disables the UI, and the
  // disabled attribute has not re-rendered within a same-frame double click (Codex r1 ref lock).
  const inFlight = useRef(false)

  const ratingValue = typeof signal === 'object' && signal !== null ? signal.rating : null
  const draft = buildDraft(signal, note)
  const canSend = !pending && draft !== null && JSON.stringify(draft) !== lastSent

  function toggleThumb(kind: 'thumbs_up' | 'thumbs_down') {
    setSignal((prev) => (prev === kind ? null : kind))
  }

  async function send() {
    if (inFlight.current) return
    const submitted = buildDraft(signal, note)
    if (!submitted) return
    inFlight.current = true
    setPending(true)
    setStatus({ kind: 'sending', message: 'Sending…' }) // clears a stale "Noted — thanks." honestly
    let token: string
    try {
      token = await getAccessToken()
    } catch {
      // getAccessToken throws only when there is no session (session.ts).
      setStatus({ kind: 'error', message: 'Your session expired — sign in again.' })
      inFlight.current = false
      setPending(false)
      return
    }
    try {
      const { feedback } = await submitTripFeedback(tripId, submitted, token)
      // Trust the persisted row, not the request we sent (the 201 echoes what was stored).
      setConfirmed(confirmedFromRow(feedback))
      setLastSent(JSON.stringify(submitted))
      setNote('')
      setStatus({ kind: 'ok', message: 'Noted — thanks.' })
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 429
          ? 'Feedback is limited to a few sends a minute — give it a moment.'
          : err instanceof ApiError && err.status === 401
            ? 'Your session expired — sign in again.'
            : 'Couldn\'t send that. Try again.'
      // note + signal selection both survive errors.
      setStatus({ kind: 'error', message })
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <div aria-busy={pending} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Thumbs up"
          aria-pressed={signal === 'thumbs_up'}
          disabled={pending}
          onClick={() => toggleThumb('thumbs_up')}
          className={pillClass(signal === 'thumbs_up')}
        >
          <ThumbIcon />
        </button>
        <button
          type="button"
          aria-label="Thumbs down"
          aria-pressed={signal === 'thumbs_down'}
          disabled={pending}
          onClick={() => toggleThumb('thumbs_down')}
          className={pillClass(signal === 'thumbs_down')}
        >
          <ThumbIcon down />
        </button>

        <div role="radiogroup" aria-label="Rate this trail" className="ml-1 flex items-center gap-0.5">
          {([1, 2, 3, 4, 5] as const).map((n) => {
            const filled = ratingValue !== null && n <= ratingValue
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={ratingValue === n}
                aria-label={`${n} star${n === 1 ? '' : 's'}`}
                disabled={pending}
                onClick={() => setSignal({ rating: n })}
                className={[
                  'rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  filled ? 'text-[var(--brass-bright)]' : 'text-[var(--muted)] hover:text-[var(--starlight)]',
                ].join(' ')}
              >
                <StarIcon filled={filled} />
              </button>
            )
          })}
        </div>
      </div>

      <textarea
        aria-label="Feedback note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={2000}
        disabled={pending}
        rows={3}
        placeholder="Wrong place, bad route, missing gem — tell us."
        className="w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-[13px] text-[var(--starlight)] placeholder:text-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brass-bright)] disabled:opacity-40"
      />

      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void send()} disabled={!canSend} className={SEND_BTN}>
          {pending ? 'Sending…' : 'Send feedback'}
        </button>
        <p role="status" className="type-label text-[12px] text-[var(--muted)]">
          {status.kind === 'idle' ? '' : status.message}
        </p>
      </div>

      {confirmed && (
        <p className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">{confirmed}</p>
      )}
    </div>
  )
}
