'use client'

import { useEffect, useRef } from 'react'
import { useMotionValueEvent, type MotionValue } from 'motion/react'

/* A muted video whose playhead is OWNED by scroll: `progress` (0→1) maps onto
   the clip's duration. The video never plays — we seek it, rAF-throttled so a
   fast scroll doesn't queue a seek per pixel. */
export default function ScrubVideo({
  progress,
  src,
  poster,
  className,
}: {
  progress: MotionValue<number>
  src: string
  poster?: string
  className?: string
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const durationRef = useRef(0)
  const targetRef = useRef(0)
  const frameRef = useRef<number | null>(null)

  const seek = () => {
    frameRef.current = null
    const video = videoRef.current
    const duration = durationRef.current
    if (!video || !duration) return
    const t = targetRef.current * duration
    // Skip sub-frame deltas; 1/30s ≈ one frame at the clips' rate.
    if (Math.abs(video.currentTime - t) > 1 / 30) video.currentTime = t
  }

  useMotionValueEvent(progress, 'change', (value) => {
    targetRef.current = Math.min(Math.max(value, 0), 0.999)
    if (frameRef.current == null) frameRef.current = requestAnimationFrame(seek)
  })

  useEffect(
    () => () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  return (
    <video
      ref={videoRef}
      className={className ?? 'story-video'}
      src={src}
      poster={poster}
      muted
      playsInline
      preload="auto"
      onLoadedMetadata={(event) => {
        durationRef.current = event.currentTarget.duration
        // Land on the current scroll position immediately (deep links, refresh mid-page).
        seek()
      }}
    />
  )
}
