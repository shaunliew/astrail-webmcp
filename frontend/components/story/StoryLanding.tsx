'use client'

import Link from 'next/link'
import { useReducedMotion } from 'motion/react'

import './story.css'

import StoryNav from './StoryNav'
import StoryProgress from './StoryProgress'
import ColdOpen from './beats/ColdOpen'
import PhoneScroll from './beats/PhoneScroll'
import Spark from './beats/Spark'
import Frenzy from './beats/Frenzy'
import Overwhelm from './beats/Overwhelm'
import Rescue from './beats/Rescue'
import PlanetJourney from './beats/PlanetJourney'
import Reveal from './beats/Reveal'
import CTA from './beats/CTA'
import { STILLS, SEATS_CLAIMED, SEATS_TOTAL } from './story-config'

/* The Astrail scroll-story landing — cold open + 7 beats, 3 acts, one
   continuous space that deepens warm→cold as you scroll. Copy is a code
   layer; the payoff is the real product. */
export default function StoryLanding() {
  const reducedMotion = useReducedMotion()

  if (reducedMotion) return <StaticStory />

  return (
    <main className="story">
      <StoryNav />
      <StoryProgress />
      <ColdOpen />
      <PhoneScroll />
      <Spark />
      <Frenzy />
      <Overwhelm />
      <Rescue />
      <PlanetJourney />
      <Reveal />
      <CTA />
    </main>
  )
}

/* prefers-reduced-motion: the same story as still frames — copy fully
   readable, scenes static, CTA reachable with zero video/WebGL. */
const STATIC_SCENES = [
  {
    src: STILLS.spark,
    headline: 'Every place you love — saved as a star.',
    dark: false,
  },
  {
    src: STILLS.overwhelm,
    headline: 'But a pile of saved places isn’t a plan.',
    dark: true,
  },
  {
    src: STILLS.rescueBurst,
    headline: 'Meet your navigator. It rounds up every place you saved —',
    dark: true,
  },
  {
    src: STILLS.globeJapan,
    headline: '— and connects them into a route that works.',
    dark: true,
  },
  {
    src: STILLS.cta,
    headline: `Be one of the first ${SEATS_TOTAL} to fly the beta.`,
    dark: false,
  },
] as const

function StaticStory() {
  return (
    <main className="story">
      <StoryNav />
      <section className="relative flex min-h-[100dvh] items-center overflow-hidden bg-[color:var(--story-ivory)]">
        <img
          src={STILLS.coldOpen}
          alt="Aster, the Astrail navigator, scrolling travel reels"
          className="story-video"
        />
        <div className="story-wash-left" />
        <div className="story-copy story-copy--center">
          <p className="story-eyebrow text-[color:var(--story-teal-ink)]">
            AI-native trip planning
          </p>
          <h1 className="story-h text-[color:var(--ink-900)]">
            Turn the reels you saved into a route you&rsquo;ll actually take.
          </h1>
          <p className="story-sub max-w-[29em] text-[color:var(--ink-600)]">
            Astrail turns scattered travel inspiration into a real itinerary on
            a map &mdash; then guides you from planning toward the whole trip.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link href="/sign-in" className="story-btn story-btn--primary">
              Start your first trail
            </Link>
          </div>
          <p className="story-sub mt-6 text-[color:var(--ink-600)]">
            <b>
              {SEATS_CLAIMED} / {SEATS_TOTAL}
            </b>{' '}
            beta seats claimed &middot; self-funded first flight
          </p>
        </div>
      </section>

      {STATIC_SCENES.map((scene) => (
        <section
          key={scene.headline}
          className="relative overflow-hidden"
          style={{ background: scene.dark ? 'var(--story-void)' : 'var(--story-ivory)' }}
        >
          <img src={scene.src} alt="" className="block w-full" />
          <div className="mx-auto max-w-4xl px-6 py-14">
            <h2
              className="story-h"
              style={{ color: scene.dark ? 'var(--starlight)' : 'var(--ink-900)' }}
            >
              {scene.headline}
            </h2>
          </div>
        </section>
      ))}

      <section className="bg-[color:var(--paper-1)] px-6 py-16 text-center">
        <Link href="/sign-in" className="story-btn story-btn--primary">
          Claim a seat
        </Link>
      </section>
    </main>
  )
}
