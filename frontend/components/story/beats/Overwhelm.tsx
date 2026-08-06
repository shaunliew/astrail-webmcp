'use client'

import { motion, useTransform } from 'motion/react'

import ScrubVideo from '../ScrubVideo'
import { useBeatProgress } from '../useBeatProgress'
import { CLIPS, STILLS } from '../story-config'

/* Beat 3 — the overwhelm. Scroll-scrubbed on purpose: the star-mountain rises
   AS the user scrolls — the overwhelm compounds under your own thumb. First
   dark act; the warm→cold arc starts here. */
export default function Overwhelm() {
  const { ref, progress } = useBeatProgress()

  const copyOpacity = useTransform(progress, [0.42, 0.6], [0, 1])
  const copyY = useTransform(progress, [0.42, 0.6], [28, 0])

  return (
    <div ref={ref} className="story-beat h-[240vh]">
      <section className="story-scene bg-[color:var(--story-dusk)]">
        <ScrubVideo
          progress={progress}
          src={CLIPS.overwhelm}
          poster={STILLS.overwhelm}
        />
        <div className="story-scrim-dark" />
        <motion.div
          className="story-copy story-copy--bottom"
          style={{ opacity: copyOpacity, y: copyY }}
        >
          <h2 className="story-h text-[color:var(--starlight)]">
            But a pile of saved places isn&rsquo;t a plan.
          </h2>
          <p className="story-sub text-[color:var(--starlight-70)]">
            So much inspiration. No idea where to start.
          </p>
        </motion.div>
      </section>
    </div>
  )
}
