'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { motion, useScroll, useSpring, useTransform } from 'motion/react'

import '../story.css'

import StoryNav from '../StoryNav'
import Beat0Layer from './Beat0Layer'
import Beat1Layer from './Beat1Layer'
import SparkLayer from './SparkLayer'
import StarWipe from './StarWipe'
import { useLenis } from './useLenis'
import { RUNWAY_VH, T } from './timeline'
import { BOARDING_OPEN, SEATS_TOTAL } from '../story-config'
import { tallyFallbackUrl } from '@/components/landing/landing-copy'

/* THE ONE STAGE — proof slice (beats 0→2).

   Grammar (Zhi Hao, 2026-08-02): the scroll is the camera. One fixed,
   viewport-filling stage holds every beat as a layer; the document is just a
   long runway; every transition is a scroll-owned camera move THROUGH the
   space (zoom into the phone, star-wipe out of it) — never a section sliding
   past the viewport. Videos are textures inside the world, not the world.

   Transition 1→2 has two variants for the feel test: ?t12=star (default) or
   ?t12=pull. */
export default function StoryStage() {
  useLenis()
  const { scrollYProgress } = useScroll()
  // One smoothed master timeline; every layer keys off this.
  const progress = useSpring(scrollYProgress, { stiffness: 110, damping: 26 })

  const [variant, setVariant] = useState<'star' | 'pull'>('star')
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('t12') === 'pull') {
      setVariant('pull')
    }
  }, [])

  // text-layer windows
  const heroCopyOpacity = useTransform(
    progress,
    [0, T.heroCopyOut[0], T.heroCopyOut[1]],
    [1, 1, 0],
  )
  const heroCopyY = useTransform(progress, T.heroCopyOut as unknown as number[], [0, -30])
  const hintOpacity = useTransform(progress, [0, 0.04, 0.08], [1, 1, 0])
  const sparkCopyOpacity = useTransform(progress, T.sparkCopy as unknown as number[], [0, 1])
  const sparkCopyY = useTransform(progress, T.sparkCopy as unknown as number[], [24, 0])
  const capOpacity = useTransform(progress, T.cap as unknown as number[], [0, 1])

  return (
    <main className="story">
      {/* the runway — invisible; its height is the story's duration */}
      <div style={{ height: `${RUNWAY_VH}vh` }} aria-hidden />

      {/* THE STAGE — fixed, never scrolls, content transforms inside it */}
      <div className="fixed inset-0 overflow-hidden bg-[color:var(--story-ivory)]">
        <Beat0Layer progress={progress} />
        <Beat1Layer progress={progress} />
        <SparkLayer progress={progress} variant={variant} />
        {variant === 'star' ? <StarWipe progress={progress} /> : null}

        {/* ---- text layers (all fixed over the stage) ---- */}
        <motion.div
          className="story-copy story-copy--center"
          // inline zIndex: .story-copy's unlayered z-index:3 beats Tailwind's
          // layered z-utilities, so the text would hide under z-4+ scene layers
          style={{ opacity: heroCopyOpacity, y: heroCopyY, zIndex: 40 }}
        >
          <p className="story-eyebrow text-[color:var(--story-teal-ink)]">
            AI-native trip planning
          </p>
          <h1 className="story-h text-[color:var(--ink-900)] [font-size:clamp(2.4rem,4.6vw,4rem)]">
            Turn the reels you saved into a route you&rsquo;ll{' '}
            <span className="text-[color:var(--story-teal-ink)]">actually take.</span>
          </h1>
          <p className="story-sub max-w-[29em] text-[color:var(--ink-600)]">
            Astrail turns scattered travel inspiration into a real itinerary on
            a map &mdash; then guides you from planning toward the whole trip.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            {BOARDING_OPEN ? (
              <Link href="/sign-in" className="story-btn story-btn--primary">
                Start your first trail
              </Link>
            ) : (
              <a
                href={tallyFallbackUrl}
                target="_blank"
                rel="noreferrer"
                className="story-btn story-btn--primary"
              >
                Join the waitlist
              </a>
            )}
          </div>
          <p className="story-sub mt-7 text-[15px] text-[color:var(--ink-600)]">
            <b className="font-bold text-[color:var(--ink-900)]">
              {SEATS_TOTAL}-seat
            </b>{' '}
            self-funded beta &middot; boarding soon
          </p>
        </motion.div>

        <motion.div
          className="story-copy story-copy--center"
          style={{ opacity: sparkCopyOpacity, y: sparkCopyY, zIndex: 40 }}
        >
          <p className="story-eyebrow text-[color:var(--story-teal-ink)]">The spark</p>
          <h2 className="story-h text-[color:var(--ink-900)]">
            Every place you love &mdash; saved as a star.
          </h2>
          <p className="story-caption text-[color:var(--ink-600)]">One tap. One star.</p>
        </motion.div>

        <motion.div className="story-scroll-hint" style={{ opacity: hintOpacity, zIndex: 40 }}>
          <span>Scroll to begin</span>
          <span aria-hidden>&darr;</span>
        </motion.div>

        {/* slice end-cap — temporary marker for the feel review */}
        <motion.div
          className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full border border-[color:var(--paper-line-2)] bg-[color:var(--paper-0)] px-5 py-2 text-[12px] uppercase tracking-[0.16em] text-[color:var(--ink-600)]"
          style={{ opacity: capOpacity, zIndex: 40 }}
        >
          proof slice ends here &middot; beats 3&ndash;7 follow this grammar next
        </motion.div>
      </div>

      <StoryNav />
    </main>
  )
}
