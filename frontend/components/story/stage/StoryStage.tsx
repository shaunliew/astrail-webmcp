'use client'

import Link from 'next/link'

import '../story.css'

import StoryNav from '../StoryNav'
import Beat0Layer from './Beat0Layer'
import AsterStory from '../sections/AsterStory'
import HowItWorks from '../sections/HowItWorks'
import LiveMapDemo from '../sections/LiveMapDemo'
import DemoVideoSlot from '../sections/DemoVideoSlot'
import FAQ from '../sections/FAQ'
import FinalCTA from '../sections/FinalCTA'
import StoryFooter from '../sections/StoryFooter'
import { useLenis } from './useLenis'

/* PRODUCT-FIRST HYBRID, repointed to the open beta (2026-08-03).

   Aster walks in and idles, a two-chapter story interlude says who he is and
   why Astrail exists (ZH, 2026-08-06), then the page scrolls into the real
   product: how it works (real screenshots), a live map,
   the demo video, the FAQ, an honest FOMO CTA, and a full footer. The primary
   action everywhere is "Sign in to try it" (the tools act as the signed-in user), because
   signing up and using it puts you in the running for one of the 25 unlimited
   seats, which we grant at our discretion. */
export default function StoryStage() {
  useLenis()

  return (
    <main className="story">
      {/* ---- HERO: Aster walks in and idles. No metaphor transition. ---- */}
      <section className="story-hero relative h-[100dvh] min-h-[640px] overflow-hidden bg-[color:var(--story-ivory)]">
        <Beat0Layer />
        <div className="story-wash-left" />

        <div className="story-copy story-copy--center" style={{ zIndex: 40 }}>
          <p className="story-eyebrow text-[color:var(--story-teal-ink)]">
            AI-native trip planning &middot; WebMCP Challenge build
          </p>
          <h1 className="story-h text-[color:var(--ink-900)] [font-size:clamp(2.4rem,4.6vw,4rem)]">
            Turn the reels you saved into a route you&rsquo;ll{' '}
            <span className="text-[color:var(--story-teal-ink)]">actually take.</span>
          </h1>
          <p className="story-sub max-w-[29em] text-[color:var(--ink-600)]">
            Astrail turns scattered travel inspiration into a real itinerary on
            a map, with the evidence attached to every stop. This build adds{' '}
            <b className="font-bold text-[color:var(--ink-900)]">WebMCP</b>, so an
            agent can do all of it with you, on the page you are looking at.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link href="/sign-in" className="story-btn story-btn--primary">
              Sign in to try it
            </Link>
            <a href="#how-it-works" className="story-btn story-btn--ghost">
              See how it works
            </a>
          </div>
          <p className="story-sub mt-7 text-[15px] text-[color:var(--ink-600)]">
            Open it in ChatGPT&rsquo;s built-in browser and ask{' '}
            <b className="font-bold text-[color:var(--ink-900)]">
              &ldquo;what can I do here?&rdquo;
            </b>{' '}
            &mdash; sixteen tools answer, and then act.
          </p>
        </div>

        <div className="story-scroll-hint" style={{ zIndex: 40 }}>
          <span>Scroll to begin</span>
          <span aria-hidden>&darr;</span>
        </div>
      </section>

      {/* ---- STORY INTERLUDE: who Aster is, why Astrail exists (the two
           locked keyframes: overwhelm → rescue-burst), then straight into
           the real product. ---- */}
      <AsterStory />

      {/* ---- TRUST SECTIONS: the real product carries the page ---- */}
      <HowItWorks />
      <LiveMapDemo />
      <DemoVideoSlot />
      <FAQ />
      <FinalCTA />
      <StoryFooter />

      <StoryNav />
    </main>
  )
}
