'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { motion, useMotionValueEvent, useTransform } from 'motion/react'

import { useBeatProgress } from '../useBeatProgress'
import { STILLS } from '../story-config'

/* Beat 6 — the reveal. Dive into the Japan globe → cloud whiteout → the REAL
   Mapbox app. The metaphor resolves into software: the flight-trail becomes
   the route line, the globes become numbered pins. Map mounts lazily just
   before it's needed so the WebGL cost never lands above the fold. */

const StoryRevealMap = dynamic(() => import('../StoryRevealMap'), { ssr: false })

export default function Reveal() {
  const { ref, progress } = useBeatProgress()
  const [mapLive, setMapLive] = useState(false)
  // The globe hides via React state, flipped while the whiteout is fully
  // opaque — so the cut is invisible. (A MotionValue opacity on this element
  // froze at its initial value; scale on the same element tracked fine.)
  const [pastDive, setPastDive] = useState(false)

  useMotionValueEvent(progress, 'change', (v) => {
    if (v > 0.1 && !mapLive) setMapLive(true)
    setPastDive(v > 0.46)
  })

  // Dive: the destination globe swallows the frame…
  const globeScale = useTransform(progress, [0, 0.42], [0.34, 7])
  // …the clouds white out…
  const cloudOpacity = useTransform(progress, [0.3, 0.44, 0.52, 0.7], [0, 1, 1, 0])
  // …and clear onto the live map.
  const copyOpacity = useTransform(progress, [0.68, 0.8], [0, 1])
  const copyY = useTransform(progress, [0.68, 0.8], [26, 0])

  return (
    <div ref={ref} className="story-beat h-[300vh]">
      <section className="story-scene bg-[color:var(--story-void)]">
        {/* the real app, underneath everything. The wrapper owns positioning:
            mapbox-gl.css forces `.mapboxgl-map { position: relative }` (it
            loads after Tailwind, so `absolute` on the map div itself loses). */}
        {mapLive ? (
          <div className="absolute inset-0">
            <StoryRevealMap className="h-full w-full" />
          </div>
        ) : null}

        {/* the Japan tiny-planet we dive into */}
        <motion.div
          aria-hidden
          className={`absolute left-1/2 top-1/2 z-[2] w-[min(70vh,70vw)] -translate-x-1/2 -translate-y-1/2 ${
            pastDive ? 'invisible' : ''
          }`}
          style={{ scale: globeScale }}
        >
          <img src={STILLS.globeJapan} alt="" className="w-full rounded-full" />
        </motion.div>

        {/* cloud whiteout — the dark-space → bright-map bridge */}
        <motion.div
          aria-hidden
          className="absolute inset-0 z-[3]"
          style={{
            opacity: cloudOpacity,
            background:
              'radial-gradient(ellipse 80% 60% at 50% 45%, #ffffff 0%, rgba(255,255,255,0.96) 45%, rgba(244,240,232,0.9) 100%)',
          }}
        />

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[4] h-[38%] bg-gradient-to-t from-[rgba(8,12,26,0.9)] to-transparent" />
        <motion.div
          className="story-copy story-copy--bottom z-[5]"
          style={{ opacity: copyOpacity, y: copyY }}
        >
          <p className="story-eyebrow text-[color:var(--story-teal-night)]">
            The reveal
          </p>
          <h2 className="story-h text-[color:var(--starlight)]">
            A real itinerary on a real map. Not another list.
          </h2>
          <p className="story-sub text-[color:var(--starlight-70)]">
            Every stop placed, numbered, and connected, with the evidence
            it came from.
          </p>
        </motion.div>
      </section>
    </div>
  )
}
