'use client'

import { motion, useTransform } from 'motion/react'

import PlayOnceVideo from '../PlayOnceVideo'
import { useBeatProgress } from '../useBeatProgress'
import { CLIPS, STILLS } from '../story-config'

/* Beat 2 — the spark. A reel lights him up and peels off the phone as a star:
   the save-gesture IS the product's input. Clip plays once; copy sits in the
   art's empty left half. */
export default function Spark() {
  const { ref, progress } = useBeatProgress()

  const copyOpacity = useTransform(progress, [0.15, 0.35], [0, 1])
  const copyY = useTransform(progress, [0.15, 0.35], [24, 0])

  return (
    <div ref={ref} className="story-beat h-[170vh]">
      <section className="story-scene bg-[color:var(--story-ivory)]">
        <PlayOnceVideo src={CLIPS.spark} poster={STILLS.spark} />
        <motion.div
          className="story-copy story-copy--center"
          style={{ opacity: copyOpacity, y: copyY }}
        >
          <p className="story-eyebrow text-[color:var(--story-teal-ink)]">The spark</p>
          <h2 className="story-h text-[color:var(--ink-900)]">
            Every place you love &mdash; saved as a star.
          </h2>
          <p className="story-caption text-[color:var(--ink-600)]">
            One tap. One star.
          </p>
        </motion.div>
      </section>
    </div>
  )
}
