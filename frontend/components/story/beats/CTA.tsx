'use client'

import Link from 'next/link'

import PlayOnceVideo from '../PlayOnceVideo'
import { tallyFallbackUrl } from '@/components/landing/landing-copy'
import { CLIPS, STILLS, SEATS_CLAIMED, SEATS_TOTAL } from '../story-config'

/* Beat 7 — board the mission. Warm bookend, full circle to the cold open: the
   mech flies down, lands, and waves (clip is end-image pinned to the locked
   CTA art). Honest 25-seat mechanic; future agents teased as coming, never
   claimed live. The left wash also masks the form baked into the art — the
   real controls are HTML on top. */
export default function CTA() {
  return (
    <section className="relative min-h-[100dvh] overflow-hidden bg-[color:var(--paper-1)]">
      <PlayOnceVideo src={CLIPS.cta} poster={STILLS.cta} amount={0.35} />
      <div className="story-wash-left" />

      <div className="story-copy story-copy--center">
        <p className="story-eyebrow text-[color:var(--story-teal-ink)]">
          Board the mission
        </p>
        <h2 className="story-h text-[color:var(--ink-900)]">
          Be one of the first {SEATS_TOTAL} to fly the beta.
        </h2>
        <p className="story-sub max-w-[30em] text-[color:var(--ink-600)]">
          We&rsquo;re self-funded, so the first flight carries just {SEATS_TOTAL}{' '}
          explorers. Paste the reels you saved, set your dates, and fly the
          planning flow that turns them into a real route.
        </p>

        <div className="story-seats mt-7 text-[color:var(--ink-600)]">
          <span className="story-seats__bar">
            <span
              className="story-seats__fill"
              style={{ width: `${(SEATS_CLAIMED / SEATS_TOTAL) * 100}%` }}
            />
          </span>
          <span>
            <b className="font-bold text-[color:var(--ink-900)]">
              {SEATS_CLAIMED} / {SEATS_TOTAL}
            </b>{' '}
            seats claimed
          </span>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Link href="/sign-in" className="story-btn story-btn--primary">
            Claim a seat
          </Link>
          <a
            href={tallyFallbackUrl}
            target="_blank"
            rel="noreferrer"
            className="story-btn story-btn--ghost"
          >
            Join the waitlist ↗
          </a>
        </div>

        <p className="mt-10 text-[13px] uppercase tracking-[0.16em] text-[color:var(--ink-400)]">
          Coming in the full launch &mdash; Compare &middot; Stay &middot; Book
        </p>
      </div>
    </section>
  )
}
