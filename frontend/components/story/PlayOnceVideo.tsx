'use client'

import { useEffect, useRef } from 'react'
import { useInView } from 'motion/react'

/* A muted clip that plays exactly once when its beat scrolls into view, then
   holds its final frame (the locked keyframe, for end-image-pinned clips). */
export default function PlayOnceVideo({
  src,
  poster,
  className,
  amount = 0.45,
}: {
  src: string
  poster?: string
  className?: string
  /** How much of the video must be visible before it starts. */
  amount?: number
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const inView = useInView(videoRef, { amount, once: true })

  useEffect(() => {
    if (!inView) return
    // Reduced-motion: hold the poster (the clip's locked final frame) instead
    // of autoplaying — mirrors the hero (Beat0Layer). Keeps the CTA still for
    // users who asked the OS for less motion.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    videoRef.current?.play().catch(() => {})
  }, [inView])

  return (
    <video
      ref={videoRef}
      className={className ?? 'story-video'}
      src={src}
      poster={poster}
      muted
      playsInline
      preload="auto"
    />
  )
}
