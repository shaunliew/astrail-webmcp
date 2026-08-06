'use client'

import { motion, useTransform, type MotionValue } from 'motion/react'

import { T } from './timeline'

/* Beat 1→2 transition, star variant: on the last flick the loved reel lifts
   off as a golden star that flies AT the camera — its glow floods the frame
   and the spark scene resolves underneath as it clears.
   "Catch the star. Store the star." — the wipe IS the brand gesture.
   Fully scroll-owned: scrub it, reverse it, stop mid-flood. */
export default function StarWipe({ progress }: { progress: MotionValue<number> }) {
  const [t0, t1] = T.t12
  const mid = (t0 + t1) / 2

  // the star rises from the phone's heart and blows past the camera,
  // then dies INTO the flood peak (it must fully exit, or its glow would
  // sit over every later beat)
  const starScale = useTransform(progress, [t0, mid], [0.2, 26])
  const starY = useTransform(progress, [t0, mid], ['12%', '-6%'])
  const starOpacity = useTransform(
    progress,
    [t0, t0 + 0.01, mid - 0.01, mid + 0.015],
    [0, 1, 1, 0],
  )
  // the glow flood: peaks mid-transition, clears onto the spark scene
  const floodOpacity = useTransform(progress, [t0 + 0.02, mid, t1], [0, 1, 0])

  return (
    <>
      {/* the flying star */}
      <motion.div
        aria-hidden
        className="absolute left-1/2 top-1/2 z-[5] h-24 w-24 -translate-x-1/2 -translate-y-1/2"
        style={{ scale: starScale, y: starY, opacity: starOpacity }}
      >
        <div
          className="h-full w-full"
          style={{
            background:
              'radial-gradient(circle, #fff7e0 0%, #E8B667 34%, rgba(232,182,103,0.35) 62%, transparent 75%)',
            filter: 'blur(1px)',
          }}
        />
      </motion.div>
      {/* the screen-filling glow flood */}
      <motion.div
        aria-hidden
        className="absolute inset-0 z-[6]"
        style={{
          opacity: floodOpacity,
          background:
            'radial-gradient(ellipse 90% 70% at 50% 48%, #fffdf6 0%, #fdf3da 40%, rgba(240,233,220,0.92) 100%)',
        }}
      />
    </>
  )
}
