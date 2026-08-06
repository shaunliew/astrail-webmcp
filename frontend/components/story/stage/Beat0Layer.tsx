'use client'

import { useEffect, useRef, useState } from 'react'

import { CLIPS, STILLS } from '../story-config'

/* The hero character moment. Aster walks in from off-screen, settles STANDING,
   then a frame-anchored idle loop takes over so he never freezes while the
   page waits for a scroll. The two clips share the walk-in's true final frame,
   crossfaded at the swap so the handoff is invisible. No scroll transforms —
   the hero is a plain section that scrolls away into the product. */
export default function Beat0Layer() {
  const walkRef = useRef<HTMLVideoElement | null>(null)
  const idleRef = useRef<HTMLVideoElement | null>(null)
  const [walkDone, setWalkDone] = useState(false)

  useEffect(() => {
    // Reduced-motion: hold the standing still — no walk-in, no idle loop.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    walkRef.current?.play().catch(() => {})
  }, [])

  return (
    <div className="absolute inset-0">
      {/* walk-in: plays once (skipped under reduced-motion), ends standing */}
      <video
        ref={walkRef}
        className="story-video"
        src={CLIPS.coldOpen}
        poster={STILLS.coldOpen}
        muted
        playsInline
        preload="auto"
        onEnded={() => {
          idleRef.current?.play().catch(() => {})
          setWalkDone(true)
        }}
        style={{ opacity: walkDone ? 0 : 1, transition: 'opacity 0.35s ease' }}
      />
      {/* idle loop: anchored to the walk-in's actual last frame → seamless.
          Poster mirrors the walk-in still so a missing clip degrades to the
          standing frame, never a blank box. */}
      <video
        ref={idleRef}
        className="story-video"
        src={CLIPS.coldOpenIdle}
        poster={STILLS.coldOpen}
        muted
        playsInline
        loop
        preload="metadata"
        style={{ opacity: walkDone ? 1 : 0, transition: 'opacity 0.35s ease' }}
      />
      {/* Phones only (CSS): a centered, full-figure Aster still. The 16:9 clip
          crops him to a corner on portrait; this reads balanced under the copy.
          Desktop keeps the walk-in + idle video above. */}
      <img
        className="story-hero-aster-mobile"
        src="/landing/aster-hero-mobile.webp"
        alt=""
        aria-hidden="true"
      />
    </div>
  )
}
