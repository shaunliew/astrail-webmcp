'use client'

import { useRef, useState } from 'react'
import {
  motion,
  useMotionValueEvent,
  useTransform,
  type MotionValue,
} from 'motion/react'

import { CLIPS, STILLS } from '../story-config'
import { T } from './timeline'

/* Beat 2 on the stage. Enters through the chosen 1→2 camera move:
   - star variant: revealed under the star-glow flood (no transform of its own)
   - pull variant: starts enlarged (as if the camera were still inside the
     phone) and pulls back to rest — the zoom-out mirror of the 0→1 dive.
   The clip plays once when its window becomes active. */
export default function SparkLayer({
  progress,
  variant,
}: {
  progress: MotionValue<number>
  variant: 'star' | 'pull'
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [played, setPlayed] = useState(false)

  useMotionValueEvent(progress, 'change', (v) => {
    if (!played && v >= T.spark[0]) {
      videoRef.current?.play().catch(() => {})
      setPlayed(true)
    }
  })

  const opacity = useTransform(progress, T.t12 as unknown as number[], [0, 1])
  const pullScale = useTransform(progress, T.t12 as unknown as number[], [1.6, 1])
  const pointerEvents = useTransform(opacity, (o) => (o < 0.05 ? 'none' : 'auto'))

  return (
    <motion.div
      className="absolute inset-0 z-[4]"
      style={{
        opacity,
        pointerEvents,
        scale: variant === 'pull' ? pullScale : 1,
        transformOrigin: '62% 55%', // his phone in the spark art
      }}
    >
      <video
        ref={videoRef}
        className="story-video"
        src={CLIPS.spark}
        poster={STILLS.spark}
        muted
        playsInline
        preload="auto"
      />
    </motion.div>
  )
}
