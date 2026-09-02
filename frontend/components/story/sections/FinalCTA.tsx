'use client'

import Link from 'next/link'

import PlayOnceVideo from '../PlayOnceVideo'
import { CLIPS, STILLS } from '../story-config'

/* The warm bookend — the mech lands and waves. The message is the challenge build, not a beta:
   the seat/FOMO framing this comment used to describe was dropped when the FAQ was retargeted
   (landing-copy.ts), because "should I join this beta" is the wrong question in front of a judge.
   Do not restore it from this comment.

   The copy also used to say "open THIS page" and then list what the agent can do, which is false
   on `/` — `GlobalTools` mounts only under /app, so the root landing registers no tools at all.
   Say "the app", never "this page". */
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
          Not this page. The app. Open Astrail in ChatGPT&rsquo;s built-in
          browser and the agent can read what you already have, save the Reels
          you paste, build the trip while narrating each stage, move a stop to
          another day, and fly the map to it, that last one through the
          very setters your own click runs, so its camera move and yours are the
          same event, on the same map. The sample trail opens with no account.
          Moving, adding, removing or rescheduling a stop stops for a card on
          the page first.
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
          A challenge build, not a finished product, and not something you
          can sign up for. Expect rough edges.
        </p>

        <p className="mt-8 text-[13px] uppercase tracking-[0.16em] text-[color:var(--ink-400)]">
          17 tools &middot; read &middot; act &middot; every stop says where it came from
        </p>
      </div>
    </section>
  )
}
