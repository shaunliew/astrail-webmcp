'use client'

import Link from 'next/link'

import PlayOnceVideo from '../PlayOnceVideo'
import { CLIPS, STILLS } from '../story-config'

/* The warm bookend — the mech lands and waves. The message is now the open
   beta: plan free today, and the scarce thing (unlimited planning for 25
   explorers) is granted at our discretion to active early users, so the CTA IS the FOMO action.
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
          Try it with an agent
        </p>
        <h2 className="story-h text-[color:var(--ink-900)]">
          Ask it what you can do here.
        </h2>
        <p className="story-sub max-w-[32em] text-[color:var(--ink-600)]">
          Open this page in ChatGPT&rsquo;s built-in browser and the agent can
          read it, save the Reels you paste, build the trip while narrating each
          stage, and move a stop to another day &mdash; on the same map you are
          looking at. Sign in first; the tools act as you.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Link href="/sign-in" className="story-btn story-btn--primary">
            Sign in to try it
          </Link>
          <a href="#how-it-works" className="story-btn story-btn--ghost">
            See how it works
          </a>
        </div>

        <p className="mt-5 text-[13px] text-[color:var(--ink-400)]">
          A challenge build &mdash; not a finished product, and not something you
          can sign up for. Expect rough edges.
        </p>

        <p className="mt-8 text-[13px] uppercase tracking-[0.16em] text-[color:var(--ink-400)]">
          16 tools &middot; read &middot; act &middot; every claim sourced
        </p>
      </div>
    </section>
  )
}
