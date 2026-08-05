'use client'

import Link from 'next/link'

import '../story.css'

import StoryNav from '../StoryNav'
import Beat0Layer from './Beat0Layer'
import HowItWorks from '../sections/HowItWorks'
import LiveMapDemo from '../sections/LiveMapDemo'
import DemoVideoSlot from '../sections/DemoVideoSlot'
import FAQ from '../sections/FAQ'
import FinalCTA from '../sections/FinalCTA'
import StoryFooter from '../sections/StoryFooter'
import { useLenis } from './useLenis'
import { SEATS_TOTAL } from '../story-config'

/* PRODUCT-FIRST HYBRID, repointed to the open beta (2026-08-03).

   Aster walks in and idles — the one character moment — then the page scrolls
   straight into the real product: how it works (real screenshots), a live map,
   the demo video, the FAQ, an honest FOMO CTA, and a full footer. The primary
   action everywhere is "Start planning free" (sign up + generate), because
   signing up and being active is how you earn one of the 25 unlimited seats. */
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
            AI-native trip planning &middot; Now in beta
          </p>
          <h1 className="story-h text-[color:var(--ink-900)] [font-size:clamp(2.4rem,4.6vw,4rem)]">
            Turn the reels you saved into a route you&rsquo;ll{' '}
            <span className="text-[color:var(--story-teal-ink)]">actually take.</span>
          </h1>
          <p className="story-sub max-w-[29em] text-[color:var(--ink-600)]">
            Astrail turns scattered travel inspiration into a real itinerary on
            a map &mdash; with the evidence attached to every stop. Plan your
            first trip free, in minutes.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link href="/sign-in" className="story-btn story-btn--primary">
              Start planning free
            </Link>
            <a href="#how-it-works" className="story-btn story-btn--ghost">
              See how it works
            </a>
          </div>
          <p className="story-sub mt-7 text-[15px] text-[color:var(--ink-600)]">
            Free while we&rsquo;re in beta &middot; only{' '}
            <b className="font-bold text-[color:var(--ink-900)]">
              {SEATS_TOTAL} explorers
            </b>{' '}
            get unlimited planning &mdash; we pick them from the most active
            early users.
          </p>
        </div>

        <div className="story-scroll-hint" style={{ zIndex: 40 }}>
          <span>Scroll to begin</span>
          <span aria-hidden>&darr;</span>
        </div>
      </section>

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
