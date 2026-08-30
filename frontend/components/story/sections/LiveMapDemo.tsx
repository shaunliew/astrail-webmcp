'use client'

import dynamic from 'next/dynamic'
import { useRef } from 'react'
import { useInView } from 'motion/react'

/* Not a render, not a metaphor: the actual product surface. A live Mapbox
   night map with the Tokyo demo trip's numbered pins + brass route line —
   the same component the app itself is built on. Lazy-mounted on approach
   so its WebGL never taxes the fold. */
const StoryRevealMap = dynamic(() => import('../StoryRevealMap'), { ssr: false })

export default function LiveMapDemo() {
  const ref = useRef<HTMLDivElement | null>(null)
  const near = useInView(ref, { margin: '600px 0px' })

  return (
    <section className="bg-[color:var(--night-900)] px-6 py-24 md:px-12">
      <div className="mx-auto max-w-6xl">
        <p className="story-eyebrow text-[color:var(--story-teal-night)]">
          Live demo &middot; real map
        </p>
        <h2 className="story-h max-w-[26ch] text-[color:var(--starlight)]">
          A real itinerary on a real map. Not another list.
        </h2>
        <p className="story-sub max-w-[38em] text-[color:var(--starlight-70)]">
          This is the live map you&rsquo;d get: a demo Tokyo trip, every stop
          numbered and connected. Your version adds the evidence panel &mdash;
          the reel and the caption quote behind a stop that came from one,
          Astrail&rsquo;s own reasoning behind a stop it suggested, and a plain
          note on a stop you asked for yourself.
        </p>

        <div
          ref={ref}
          className="mt-12 h-[70vh] min-h-[420px] overflow-hidden rounded-xl border border-[color:var(--night-line)] shadow-[inset_0_1px_0_rgba(247,243,232,0.07),0_1px_2px_rgba(0,0,0,0.55),0_8px_28px_rgba(0,0,0,0.4)]"
        >
          {near ? (
            <StoryRevealMap className="h-full w-full" />
          ) : (
            <div className="h-full w-full bg-[color:var(--night-800)]" />
          )}
        </div>
      </div>
    </section>
  )
}
