'use client'

import Link from 'next/link'

import PlayOnceVideo from '../PlayOnceVideo'
import { CLIPS, STILLS, SEATS_CLAIMED, SEATS_TOTAL } from '../story-config'

/* Beat 0 — the Pixar cold open. Empty stage; Aster walks in from beyond the
   right edge and settles into the locked hero keyframe (the clip is end-image
   pinned, so its final frame IS the mock composition). Words live in code. */
export default function ColdOpen() {
  return (
    <section className="relative h-[100dvh] min-h-[660px] overflow-hidden bg-[color:var(--story-ivory)]">
      <PlayOnceVideo src={CLIPS.coldOpen} poster={STILLS.coldOpen} amount={0.3} />
      <div className="story-wash-left" />

      <div className="story-copy story-copy--center">
        <p className="story-eyebrow text-[color:var(--story-teal-ink)]">
          AI-native trip planning
        </p>
        <h1 className="story-h text-[color:var(--ink-900)] [font-size:clamp(2.4rem,4.6vw,4rem)]">
          Turn the reels you saved into a route you&rsquo;ll{' '}
          <span className="text-[color:var(--story-teal-ink)]">actually take.</span>
        </h1>
        <p className="story-sub max-w-[29em] text-[color:var(--ink-600)]">
          Astrail turns scattered travel inspiration into a real itinerary on a
          map, then guides you from planning toward the whole trip.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Link href="/sign-in" className="story-btn story-btn--primary">
            Start your first trail
          </Link>
          <a href="#the-scroll" className="story-btn story-btn--ghost">
            Watch the mission
          </a>
        </div>
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
            beta seats claimed &middot; self-funded first flight
          </span>
        </div>
      </div>

      <div className="story-scroll-hint">
        <span>Scroll to begin</span>
        <span aria-hidden>&darr;</span>
      </div>
    </section>
  )
}
