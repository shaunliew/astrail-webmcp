import Link from 'next/link'

// Presentational entitlement card (plan L825-829). Three prop-driven states:
//   - exhausted / not-yet-requested → the copy + a "Request a seat" button
//   - request-sent OR already-requested (both `seatRequested`) → a confirmation, no button
// Plus an "Open your trip" recovery link to the canonical trip, hidden while that id is still
// loading or if none resolves. The hook (Task 9) supplies these props; kept dumb so it renders
// in isolation for tests. Copy is fixed — no invented numbers beyond the "25" in the body.
export type TrialExhaustedCardProps = {
  seatRequested: boolean
  onRequestSeat: () => void
  requesting?: boolean
  canonicalTripId: string | null
  canonicalTripLoading: boolean
}

export default function TrialExhaustedCard({
  seatRequested,
  onRequestSeat,
  requesting = false,
  canonicalTripId,
  canonicalTripLoading,
}: TrialExhaustedCardProps) {
  const showTripLink = !canonicalTripLoading && canonicalTripId !== null

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] p-5">
      <h3 className="type-display text-lg text-[color:var(--text)]">Your free trip is planned.</h3>
      <p className="type-body text-[13px] text-[color:var(--text-muted)]">
        Beta seats unlock unlimited planning — we&apos;re self-funded, so only 25 exist.
      </p>

      {seatRequested ? (
        <p
          role="status"
          className="type-label rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-0)] px-3 py-2 text-[13px] text-[color:var(--brass-deep)]"
        >
          Seat requested — we&apos;ll let you know when one opens.
        </p>
      ) : (
        <button
          type="button"
          onClick={onRequestSeat}
          disabled={requesting}
          className="flex min-h-[48px] w-full items-center justify-center rounded-full border border-[color:var(--accent)] bg-[color:var(--accent)] px-5 text-[14px] font-medium text-[color:var(--accent-text)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60"
        >
          {requesting ? 'Requesting…' : 'Request a seat'}
        </button>
      )}

      {showTripLink ? (
        <Link
          href={`/app/trip/${canonicalTripId}`}
          className="type-label text-center text-[13px] text-[color:var(--brass-deep)] underline underline-offset-2 hover:opacity-80"
        >
          Open your trip
        </Link>
      ) : null}
    </div>
  )
}
