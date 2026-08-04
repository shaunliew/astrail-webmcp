'use client'

import { useEffect, useRef, useState } from 'react'
import { useUser } from '@/lib/auth/use-user'
import { getAccessToken } from '@/lib/supabase/session'
import {
  ApiError,
  cancelAccountDeletion,
  getAccountDeletionStatus,
  requestAccountDeletion,
} from '@/lib/trip/api'
import {
  ERROR_CODE_DELETION_ALREADY_STARTED,
  ERROR_CODE_DELETION_NOT_ACTIVE,
  ERROR_CODE_DELETION_UNAVAILABLE,
  ERROR_CODE_NO_PENDING_DELETION,
  type AccountDeletionStatus,
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
  // Pre-fetch default for the cross-session status seed below: the props are the state the card
  // shows until the on-mount GET /account/deletion/status resolves and overwrites them (a returning
  // pending/deleting user then lands directly on the banner, without an in-session request).
  initialStatus = 'active',
  initialScheduledFor = null,
}: {
  initialStatus?: AccountDeletionStatus
  initialScheduledFor?: string | null
}) {
  const { user } = useUser()
  const email = user?.email ?? ''

  const [status, setStatus] = useState<AccountDeletionStatus>(initialStatus)
  const [scheduledFor, setScheduledFor] = useState<string | null>(initialScheduledFor)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Neutral (non-error) note — distinct from `error` (--fail): used when a Cancel finds nothing
  // pending, so the banner doesn't just vanish silently.
  const [notice, setNotice] = useState<string | null>(null)
  // Unmount guard (mirrors SettingsView) — the async handlers + status fetch setState after an
  // await; if the card unmounts mid-request this ref short-circuits the stale update.
  const activeRef = useRef(true)

  // Cross-session seed: read the caller's own account_status on mount so a returning user is placed
  // directly on the pending banner / locked in-progress state. This runs only when the card renders,
  // and the card renders only behind NEXT_PUBLIC_DELETION_ENABLED (gated at its mount in
  // SettingsView) — so a hidden card never fetches. Fail-safe: the backend returns 'active' only for a
  // positively-read non-pending state and 'unknown' on a genuine read FAILURE (the card then shows a
  // status-unavailable notice that keeps the cancel path); a client-side transport error is swallowed
  // (default stays). A read failure never masquerades as a safe 'active'.
  useEffect(() => {
    activeRef.current = true
    void (async () => {
      try {
        const token = await getAccessToken()
        const res = await getAccountDeletionStatus(token)
        if (!activeRef.current) return
        setStatus(res.account_status)
        setScheduledFor(res.deletion_scheduled_for)
      } catch {
        /* Leave the pre-fetch default (active) — the delete control still renders. */
      }
    })()
    return () => {
      activeRef.current = false
    }
  }, [])

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
    setNotice(null)
    try {
      const token = await getAccessToken()
      const res = await requestAccountDeletion(token)
      if (!activeRef.current) return
      setScheduledFor(res.scheduled_for)
      setStatus('pending_deletion')
      setDialogOpen(false)
      setConfirmText('')
    } catch (e) {
      if (!activeRef.current) return
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
      if (activeRef.current) setBusy(false)
    }
  }

  async function handleCancel() {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const token = await getAccessToken()
      await cancelAccountDeletion(token)
      if (!activeRef.current) return
      setStatus('active')
      setScheduledFor(null)
    } catch (e) {
      if (!activeRef.current) return
      if (e instanceof ApiError && e.code === ERROR_CODE_DELETION_ALREADY_STARTED) {
        // The sweeper claimed the account (Task 3's point of no return) — reflect it, lock Cancel.
        setStatus('deleting')
      } else if (e instanceof ApiError && e.code === ERROR_CODE_NO_PENDING_DELETION) {
        // Nothing to cancel (e.g. it was already cancelled elsewhere) — return to the delete control
        // WITH a brief neutral note, so the banner doesn't disappear silently.
        setStatus('active')
        setScheduledFor(null)
        setNotice('This account isn’t scheduled for deletion.')
      } else {
        setError('Couldn’t cancel right now. Please try again.')
      }
    } finally {
      if (activeRef.current) setBusy(false)
    }
  }

  const errorAlert = error ? (
    <p role="alert" className="text-[13px] text-[color:var(--fail)]">
      {error}
    </p>
  ) : null

  const noticeMessage = notice ? (
    <p role="status" className="text-[13px] text-[color:var(--text-muted)]">
      {notice}
    </p>
  ) : null

  if (status === 'unknown') {
    // Fix 5: a genuine status-read FAILURE. Do NOT render this as the normal (no-banner) active
    // state — that would hide the cancel affordance from a user who really did request deletion.
    // Show a notice that preserves cancellation guidance instead.
    return (
      <section className={CARD} aria-labelledby="delete-account-heading">
        <h2 id="delete-account-heading" className="font-display text-[18px] font-medium text-[color:var(--text)]">
          Account deletion
        </h2>
        <p role="status" className="text-[14px] text-[color:var(--text)]">
          We couldn’t confirm your account’s deletion status right now. Refresh this page, or if you
          requested deletion and don’t see a cancel option, contact support.
        </p>
      </section>
    )
  }

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
        {noticeMessage}
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
      {noticeMessage}
    </section>
  )
}
