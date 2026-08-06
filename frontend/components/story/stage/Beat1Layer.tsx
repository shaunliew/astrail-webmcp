'use client'

import { useEffect, useRef } from 'react'
import {
  motion,
  useMotionValueEvent,
  useSpring,
  useTransform,
  type MotionValue,
} from 'motion/react'

import { CLIPS, STILLS } from '../story-config'
import { T, flickTime } from './timeline'

/* Beat 1 on the stage — the first-person merge, done properly:
   scroll maps through FLICK SEGMENTS (measured from the clip), so each
   scroll gesture is one thumb-flick + one reel advance, and a SPRING chases
   the target time — release mid-flick and the flick settles itself.
   The camera also pushes slowly in, all scroll-owned. */
export default function Beat1Layer({ progress }: { progress: MotionValue<number> }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // window-local progress 0→1 across the phone beat
  const phoneP = useTransform(progress, T.phone as unknown as number[], [0, 1])
  // scroll → clip seconds through the flick segments…
  const targetTime = useTransform(phoneP, flickTime)
  // …chased by a spring so pauses settle on completed flicks
  const springTime = useSpring(targetTime, { stiffness: 90, damping: 22 })

  useMotionValueEvent(springTime, 'change', (t) => {
    const video = videoRef.current
    if (!video || !video.duration) return
    if (Math.abs(video.currentTime - t) > 1 / 30) video.currentTime = t
  })

  // Land on the right frame if the page loads mid-scroll.
  useEffect(() => {
    const video = videoRef.current
    if (video) video.currentTime = springTime.get()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const opacity = useTransform(progress, T.beat1In as unknown as number[], [0, 1])
  const scale = useTransform(progress, T.phonePush as unknown as number[], [1, 1.12])
  const pointerEvents = useTransform(opacity, (o) => (o < 0.05 ? 'none' : 'auto'))

  return (
    <motion.div className="absolute inset-0 z-[3]" style={{ opacity, scale, pointerEvents }}>
      <video
        ref={videoRef}
        className="story-video"
        src={CLIPS.phoneScroll}
        poster={STILLS.phoneScroll}
        muted
        playsInline
        preload="auto"
      />
    </motion.div>
  )
}
