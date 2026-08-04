'use client'

import { useState } from 'react'
import { useUser } from '@/lib/auth/use-user'
import { getAccessToken } from '@/lib/supabase/session'
import { ApiError, cancelAccountDeletion, requestAccountDeletion } from '@/lib/trip/api'
import {
  ERROR_CODE_DELETION_ALREADY_STARTED,
  ERROR_CODE_DELETION_NOT_ACTIVE,
  ERROR_CODE_DELETION_UNAVAILABLE,
  ERROR_CODE_NO_PENDING_DELETION,
  type AccountStatus,
} from '@/lib/trip/backend-types'

/* DeleteAccountCard — self-serve account deletion (plan §3.7). The user opens a
   type-to-confirm dialog (their exact account email OR the literal word DELETE), which enters a
   7-day cancellable grace via POST /account/deletion; while pending a banner shows the scheduled
   date + Cancel. Once the sweeper claims the account (`deleting`, Task 3's point of no return),
   Cancel returns 409 deletion_already_started and the control locks into an in-progress state.

   RENDERING IS GATED by the caller behind NEXT_PUBLIC_DELETION_ENABLED (SettingsView) — this
   whole control stays hidden until go-live (Task 6 flips the frontend flag together with the
   backend `_DELETION_EXECUTION_READY` gate). A 503 from the API is only a SECONDARY graceful
   fallback ("temporarily unavailable"), not the primary gate. The account to delete is ALWAYS the
   caller's own session (no client-supplied user id — guardrails #5/#6). */

const DELETE_KEYWORD = 'DELETE'

const CARD =
  'flex flex-col gap-4 rounded-2xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] p-5'
const DESTRUCTIVE_BTN =
  'self-start rounded-lg border border-[color:var(--fail)] px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--fail)] transition-colors hover:bg-[color:var(--surface-2)] disabled:opacity-40 disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const NEUTRAL_BTN =
  'self-start rounded-lg border border-[color:var(--paper-line-2)] bg-transparent px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--text)] transition-colors hover:bg-[color:var(--surface-2)] disabled:opacity-40 disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'

// Deterministic, locale-pinned so the shown date matches the backend's calendar day regardless
// of the viewer's timezone/locale (the schedule is a UTC instant 7 days out).
function formatScheduledDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(d)
}

export default function DeleteAccountCard({
  // Task-6 seam: a future account_status read seeds the pending/deleting banner across sessions.
  // In the current build the banner appears after an in-session request; default = active.
  initialStatus = 'active',
  initialScheduledFor = null,
}: {
  initialStatus?: AccountStatus
  initialScheduledFor?: string | null
}) {
  const { user } = useUser()
  const email = user?.email ?? ''

  const [status, setStatus] = useState<AccountStatus>(initialStatus)
  const [scheduledFor, setScheduledFor] = useState<string | null>(initialScheduledFor)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Exact match only — the point is to make an accidental delete impossible. A near-miss
  // (case-off 'delete', trailing space, partial email) stays disabled. Empty never matches even
  // when the email has not loaded (email === '' ⇒ only the DELETE keyword unlocks it).
  const canConfirm =
    confirmText.length > 0 && (confirmText === email || confirmText === DELETE_KEYWORD)

  function openDialog() {
    setConfirmText('')
    setError(null)
    setDialogOpen(true)
  }

  function closeDialog() {
    setDialogOpen(false)
    setConfirmText('')
  }

  async function handleConfirm() {
    if (!canConfirm || busy) return
    setBusy(true)
    setError(null)
    try {
      const token = await getAccessToken()
      const res = await requestAccountDeletion(token)
      setScheduledFor(res.scheduled_for)
      setStatus('pending_deletion')
      setDialogOpen(false)
      setConfirmText('')
    } catch (e) {
      // Never claim success on a failure. 503 = feature not available (secondary fallback to the
      // readiness flag); 409 not_active = a concurrent request already scheduled it; else generic.
      if (e instanceof ApiError && e.code === ERROR_CODE_DELETION_UNAVAILABLE) {
        setError('Account deletion is temporarily unavailable. Please try again later.')
      } else if (e instanceof ApiError && e.code === ERROR_CODE_DELETION_NOT_ACTIVE) {
        setError('This account is already scheduled for deletion.')
      } else {
        setError('Something went wrong — your account was not scheduled for deletion.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleCancel() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const token = await getAccessToken()
      await cancelAccountDeletion(token)
      setStatus('active')
      setScheduledFor(null)
    } catch (e) {
      if (e instanceof ApiError && e.code === ERROR_CODE_DELETION_ALREADY_STARTED) {
        // The sweeper claimed the account (Task 3's point of no return) — reflect it, lock Cancel.
        setStatus('deleting')
      } else if (e instanceof ApiError && e.code === ERROR_CODE_NO_PENDING_DELETION) {
        // Nothing to cancel (e.g. it was already cancelled elsewhere) — return to the delete control.
        setStatus('active')
        setScheduledFor(null)
      } else {
        setError('Couldn’t cancel right now. Please try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  const errorAlert = error ? (
    <p role="alert" className="text-[13px] text-[color:var(--fail)]">
      {error}
    </p>
  ) : null

  if (status === 'pending_deletion' || status === 'deleting') {
    const deleting = status === 'deleting'
    return (
      <section className={CARD} aria-labelledby="delete-account-heading">
        <h2 id="delete-account-heading" className="font-display text-[18px] font-medium text-[color:var(--text)]">
          Account deletion
        </h2>
        <p role="status" className="text-[14px] text-[color:var(--text)]">
          {deleting ? (
            'Your account deletion is in progress — this can no longer be cancelled.'
          ) : (
            <>
              Your account is scheduled for deletion on{' '}
              <time dateTime={scheduledFor ?? undefined} className="font-semibold">
                {scheduledFor ? formatScheduledDate(scheduledFor) : 'the scheduled date'}
              </time>
              . You can still cancel before then.
            </>
          )}
        </p>
        <button type="button" onClick={() => void handleCancel()} disabled={deleting || busy} className={NEUTRAL_BTN}>
          {busy ? 'Cancelling…' : 'Cancel deletion'}
        </button>
        {errorAlert}
      </section>
    )
  }

  return (
    <section className={CARD} aria-labelledby="delete-account-heading">
      <div>
        <h2 id="delete-account-heading" className="font-display text-[18px] font-medium text-[color:var(--text)]">
          Delete account
        </h2>
        <p className="mt-1 text-[13px] text-[color:var(--text-muted)]">
          Permanently delete your account and everything Astrail remembers. Your account enters a
          7-day grace period first — you can cancel any time before then.
        </p>
      </div>

      {!dialogOpen ? (
        <button type="button" onClick={openDialog} className={DESTRUCTIVE_BTN}>
          Delete account
        </button>
      ) : (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-confirm-heading"
          className="flex flex-col gap-3 rounded-xl border border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-4"
        >
          <h3 id="delete-confirm-heading" className="text-[14px] font-semibold text-[color:var(--text)]">
            This is permanent
          </h3>
          <label htmlFor="delete-confirm-input" className="text-[13px] text-[color:var(--text-muted)]">
            Type your account email (<span className="font-medium text-[color:var(--text)]">{email || 'your email'}</span>)
            or the word <span className="font-medium text-[color:var(--text)]">{DELETE_KEYWORD}</span> to confirm.
          </label>
          <input
            id="delete-confirm-input"
            type="text"
            autoComplete="off"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={DELETE_KEYWORD}
            className="min-h-11 w-full rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] px-4 text-[color:var(--text)] placeholder:text-[color:var(--text-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={!canConfirm || busy}
              className={DESTRUCTIVE_BTN}
            >
              {busy ? 'Scheduling…' : 'Confirm deletion'}
            </button>
            <button type="button" onClick={closeDialog} disabled={busy} className={NEUTRAL_BTN}>
              Keep my account
            </button>
          </div>
        </div>
      )}
      {errorAlert}
    </section>
  )
}
