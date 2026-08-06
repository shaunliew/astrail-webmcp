'use client'

import Link from 'next/link'

import PlayOnceVideo from '../PlayOnceVideo'
import { tallyFallbackUrl } from '@/components/landing/landing-copy'
import { CLIPS, SEATS_TOTAL, STILLS } from '../story-config'

/* The warm bookend — the mech lands and waves. The message is now the open
   beta: plan free today, and the scarce thing (unlimited planning for 25
   explorers) is earned by being active early, so the CTA IS the FOMO action.
   The full-launch future (hotel booking via Travala) is the subordinate
   "notify me" — never the main action. */
export default function FinalCTA() {
  return (
    <section className="story-cta relative min-h-[92vh] overflow-hidden bg-[color:var(--paper-1)]">
      {/* The warm bookend: the mech descends and waves (recovered from ZH's
          Higgsfield acct — clean empty left, no baked-in UI). Plays once when
          the section scrolls into view, then holds its final frame. */}
      <PlayOnceVideo src={CLIPS.cta} poster={STILLS.cta} amount={0.35} />
      <div className="story-wash-left" />
      {/* Phones only (CSS): the 16:9 clip composes the mech in the right
          third, so a portrait cover-crop deletes him entirely. Swap to a
          centered mech cutout under the copy — same pattern as the hero. */}
      <img
        className="story-cta-mech-mobile"
        src="/landing/cta-mech-mobile.webp"
        alt=""
        aria-hidden="true"
      />

      <div className="story-copy story-copy--center" style={{ zIndex: 40 }}>
        <p className="story-eyebrow text-[color:var(--story-teal-ink)]">
          The beta is open
        </p>
        <h2 className="story-h text-[color:var(--ink-900)]">
          Plan your first trip free. Only {SEATS_TOTAL} fly unlimited.
        </h2>
        <p className="story-sub max-w-[32em] text-[color:var(--ink-600)]">
          We&rsquo;re self-funded, so unlimited planning goes to just{' '}
          {SEATS_TOTAL} early explorers, chosen from whoever&rsquo;s
          actually using Astrail. Sign up, plan a trip, tell us what broke.
          That&rsquo;s how you earn a seat.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Link href="/sign-in" className="story-btn story-btn--primary">
            Start planning free
          </Link>
          <a href="#how-it-works" className="story-btn story-btn--ghost">
            See how it works
          </a>
        </div>

        <p className="mt-8 text-[15px] text-[color:var(--ink-600)]">
          Hotel booking (via Travala) lands with the full launch.{' '}
          <a
            href={tallyFallbackUrl}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-[color:var(--story-teal-ink)] underline underline-offset-4"
          >
            Notify me &rarr;
          </a>
        </p>

        <p className="mt-8 text-[13px] uppercase tracking-[0.16em] text-[color:var(--ink-400)]">
          Coming in the full launch: Compare &middot; Stay &middot; Book
        </p>
      </div>
    </section>
  )
}
