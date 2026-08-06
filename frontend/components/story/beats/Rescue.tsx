'use client'

import { motion, useTransform } from 'motion/react'

import ScrubVideo from '../ScrubVideo'
import { useBeatProgress } from '../useBeatProgress'
import { CLIPS, STILLS } from '../story-config'

/* Beat 4 ⭐ — the hero beat, two chained clips on one scrub:
   [0 → .62]  burst→collect: the mech Hulk-bursts the star-mountain, then its
              collector jar pops open and vortexes the star-cloud in.
   [.62 → 1]  fly-down: goggles down, thrusters, dives out of frame toward the
              planet journey. Copy per the locked rescue mock. */
export default function Rescue() {
  const { ref, progress } = useBeatProgress()

  const rescueProgress = useTransform(progress, [0, 0.62], [0, 1])
  const flyProgress = useTransform(progress, [0.62, 1], [0, 1])
  const rescueOpacity = useTransform(progress, [0.6, 0.64], [1, 0])
  const flyOpacity = useTransform(progress, [0.6, 0.64], [0, 1])

  const copyOpacity = useTransform(progress, [0.08, 0.22, 0.52, 0.62], [0, 1, 1, 0])
  const copyY = useTransform(progress, [0.08, 0.22], [30, 0])

  return (
    <div ref={ref} className="story-beat h-[300vh]">
      <section className="story-scene bg-[color:var(--story-void)]">
        <motion.div style={{ opacity: rescueOpacity }} className="absolute inset-0">
          <ScrubVideo
            progress={rescueProgress}
            src={CLIPS.rescue}
            poster={STILLS.rescueBurst}
          />
        </motion.div>
        <motion.div style={{ opacity: flyOpacity }} className="absolute inset-0">
          <ScrubVideo
            progress={flyProgress}
            src={CLIPS.flyDown}
            poster={STILLS.rescueCollect}
          />
        </motion.div>

        <div className="story-scrim-dark" />
        <motion.div
          className="story-copy story-copy--bottom max-w-[46rem]"
          style={{ opacity: copyOpacity, y: copyY }}
        >
          <p className="story-eyebrow text-[color:var(--story-teal-night)]">
            Astrail steps in
          </p>
          <h2 className="story-h text-[color:var(--starlight)]">
            Meet your navigator.
          </h2>
          <p className="story-sub text-[color:var(--starlight)] opacity-90 [font-size:clamp(1.15rem,2vw,1.5rem)]">
            It rounds up every place you saved{' '}
            <span className="text-[color:var(--story-teal-night)]">&mdash;</span>
          </p>
        </motion.div>
      </section>
    </div>
  )
}
