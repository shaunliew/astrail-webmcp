'use client'

import { useRef, useState } from 'react'

import { CLIPS, STILLS } from '../story-config'

/* The hero character moment. Aster walks in from off-screen, settles STANDING,
   then a frame-anchored idle loop takes over so he never freezes while the
   page waits for a scroll. The two clips share the walk-in's true final frame,
   crossfaded at the swap so the handoff is invisible. No scroll transforms —
   the hero is a plain section that scrolls away into the product. */
export default function Beat0Layer() {
  const idleRef = useRef<HTMLVideoElement | null>(null)
  const [walkDone, setWalkDone] = useState(false)

  return (
    <div className="absolute inset-0">
      {/* walk-in: plays once on load, ends on the settled standing frame */}
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
      {/* idle loop: anchored to the walk-in's actual last frame → seamless */}
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
    </div>
  )
}
