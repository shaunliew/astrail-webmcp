'use client'

import { useRef, useState } from 'react'
import { motion, useTransform, type MotionValue } from 'motion/react'

import { CLIPS, STILLS } from '../story-config'
import { T } from './timeline'

/* Beat 0 on the stage. Two videos share the hero keyframe as a common frame:
   the walk-in ENDS on it, the idle loop STARTS AND ENDS on it — so the swap
   at walk-in end is invisible, and Aster never stops scrolling while the
   page waits. Scroll then drives the camera INTO the phone in his paws:
   a scale transform with its origin pinned on the phone, plus blur, so the
   dive is scroll-owned (stop, reverse, scrub — it follows). */
export default function Beat0Layer({ progress }: { progress: MotionValue<number> }) {
  const idleRef = useRef<HTMLVideoElement | null>(null)
  const [walkDone, setWalkDone] = useState(false)

  const scale = useTransform(progress, T.zoom as unknown as number[], [1, 7])
  const blur = useTransform(progress, T.zoomBlur as unknown as number[], [0, 10])
  const filter = useTransform(blur, (b) => `blur(${b.toFixed(1)}px)`)
  const opacity = useTransform(progress, T.beat0Out as unknown as number[], [1, 0])
  // Never let the hidden layer intercept the pointer once it's gone.
  const pointerEvents = useTransform(opacity, (o) => (o < 0.05 ? 'none' : 'auto'))

  return (
    <motion.div
      className="absolute inset-0 z-[2]"
      style={{
        scale,
        opacity,
        filter,
        pointerEvents,
        // the phone in his paws — measured on take 5's true final standing
        // frame (settled at the right third, left half text-safe)
        transformOrigin: '51% 57%',
      }}
    >
      {/* walk-in: plays once on load, ends on the hero keyframe */}
      <video
        className="story-video"
        src={CLIPS.coldOpen}
        poster={STILLS.coldOpen}
        muted
        playsInline
        autoPlay
        preload="auto"
        onEnded={() => {
          idleRef.current?.play().catch(() => {})
          setWalkDone(true)
        }}
        style={{ opacity: walkDone ? 0 : 1, transition: 'opacity 0.35s ease' }}
      />
      {/* idle loop: anchored to the walk-in's actual last frame (start=end),
          crossfaded in so residual re-synthesis shimmer never pops */}
      <video
        ref={idleRef}
        className="story-video"
        src={CLIPS.coldOpenIdle}
        muted
        playsInline
        loop
        preload="auto"
        style={{ opacity: walkDone ? 1 : 0, transition: 'opacity 0.35s ease' }}
      />
    </motion.div>
  )
}
