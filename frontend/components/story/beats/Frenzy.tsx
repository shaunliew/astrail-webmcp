'use client'

import { motion, useTransform } from 'motion/react'

import PlayOnceVideo from '../PlayOnceVideo'
import { useBeatProgress } from '../useBeatProgress'
import { CLIPS, STILLS } from '../story-config'

/* Beat 2.5 — the saving frenzy. Pure back view, paws whirling, one rising
   line of hearts; the star-pile starts compounding. Bridges into overwhelm. */
export default function Frenzy() {
  const { ref, progress } = useBeatProgress()

  const copyOpacity = useTransform(progress, [0.2, 0.4], [0, 1])

  return (
    <div ref={ref} className="story-beat h-[150vh]">
      <section className="story-scene bg-[color:var(--story-ivory)]">
        <PlayOnceVideo src={CLIPS.frenzy} poster={STILLS.frenzy} />
        <motion.div
          className="story-copy story-copy--bottom left-0 right-0 mx-auto max-w-none px-6 text-center"
          style={{ opacity: copyOpacity }}
        >
          <p className="story-caption text-[color:var(--ink-900)]">
            One&rsquo;s never enough. You save another. And another.
          </p>
        </motion.div>
      </section>
    </div>
  )
}
