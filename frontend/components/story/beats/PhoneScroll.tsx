'use client'

import { motion, useTransform } from 'motion/react'

import ScrubVideo from '../ScrubVideo'
import { useBeatProgress } from '../useBeatProgress'
import { CLIPS, STILLS } from '../story-config'

/* Beat 1 — the first-person merge. The user's scroll IS Aster's thumb: scroll
   position drives the clip's playhead (each flick advances the feed). The
   camera push-in is done here in code so the clip itself stays scrubbable. */
export default function PhoneScroll() {
  const { ref, progress } = useBeatProgress()

  const scale = useTransform(progress, [0, 1], [1.04, 1.18])

  return (
    <div ref={ref} id="the-scroll" className="story-beat h-[260vh]">
      <section className="story-scene bg-[color:var(--story-ivory)]">
        <motion.div style={{ scale }} className="absolute inset-0">
          <ScrubVideo
            progress={progress}
            src={CLIPS.phoneScroll}
            poster={STILLS.phoneScroll}
          />
        </motion.div>
      </section>
    </div>
  )
}
