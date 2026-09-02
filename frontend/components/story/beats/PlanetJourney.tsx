'use client'

import { motion, useTransform, type MotionValue } from 'motion/react'

import { useBeatProgress } from '../useBeatProgress'
import { STILLS } from '../story-config'

/* Beat 5 — the first-person planet journey, assembled fully in code from the
   locked tiny-planet globes: scroll = throttle, each globe grows out of the
   screen and slides past the camera; a teal comet-trail draws ahead; labels
   are live HTML. */

const GLOBES = [
  { src: STILLS.globeKorea, label: 'Seoul · Day 1', drift: -16 },
  { src: STILLS.globeThailand, label: 'Bangkok · Day 2', drift: 16 },
  { src: STILLS.globeSingapore, label: 'Singapore · Day 3', drift: -14 },
] as const

/* Each globe owns a window of the beat: grows from a distant speck, fills the
   frame, then slips past the camera edge as the next one rises. */
function Globe({
  progress,
  index,
  src,
  label,
  drift,
}: {
  progress: MotionValue<number>
  index: number
  src: string
  label: string
  drift: number
}) {
  const start = 0.06 + index * 0.28
  const end = start + 0.34

  const scale = useTransform(progress, [start, end], [0.22, 2.7])
  const x = useTransform(progress, [start, end], ['0%', `${drift}%`])
  const opacity = useTransform(
    progress,
    [start, start + 0.05, end - 0.05, end],
    [0, 1, 1, 0],
  )
  const labelOpacity = useTransform(
    progress,
    [start + 0.08, start + 0.14, end - 0.1, end - 0.04],
    [0, 1, 1, 0],
  )

  return (
    <>
      {/* scale/x/opacity on a div wrapper — MotionValue opacity updates don't
          reach replaced elements (<img>) reliably, while divs track exactly. */}
      <motion.div
        aria-hidden
        className="absolute left-1/2 top-1/2 z-[1] w-[min(64vh,64vw)] -translate-x-1/2 -translate-y-1/2"
        style={{ scale, x, opacity }}
      >
        <img src={src} alt="" className="w-full rounded-full" />
      </motion.div>
      <motion.p
        className="absolute bottom-[12%] left-1/2 z-[2] -translate-x-1/2 rounded-full border border-[color:var(--night-line)] bg-[rgba(10,13,20,0.62)] px-5 py-2 font-mono text-sm tracking-[0.14em] text-[color:var(--starlight)] backdrop-blur-sm"
        style={{ opacity: labelOpacity }}
      >
        {label}
      </motion.p>
    </>
  )
}

export default function PlanetJourney() {
  const { ref, progress } = useBeatProgress()

  const trailLength = useTransform(progress, [0.05, 0.92], [0, 1])
  const headOpacity = useTransform(progress, [0, 0.12], [0, 1])
  const subOpacity = useTransform(progress, [0.5, 0.62], [0, 1])

  return (
    <div ref={ref} className="story-beat h-[320vh]">
      <section className="story-scene bg-[color:var(--story-void)]">
        <div className="story-starfield" />

        {/* teal comet-trail streaming ahead, linking the stops */}
        <svg
          className="absolute inset-0 z-[1] h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <motion.path
            d="M 50 104 C 38 78, 66 62, 50 46 C 36 32, 58 22, 50 8"
            fill="none"
            stroke="var(--story-teal)"
            strokeWidth="0.55"
            strokeLinecap="round"
            style={{
              pathLength: trailLength,
              filter: 'drop-shadow(0 0 4px rgba(70,214,198,0.75))',
            }}
          />
        </svg>

        {GLOBES.map((globe, i) => (
          <Globe key={globe.label} progress={progress} index={i} {...globe} />
        ))}

        <motion.div
          className="story-copy top-[8%] max-w-[44rem]"
          style={{ opacity: headOpacity }}
        >
          <h2 className="story-h text-[color:var(--starlight)] [font-size:clamp(1.9rem,3.6vw,3rem)]">
            and connects them into a route that works.
          </h2>
          <motion.p
            className="story-sub text-[color:var(--starlight-70)]"
            style={{ opacity: subOpacity }}
          >
            Grouped by day. Mapped by place.
          </motion.p>
        </motion.div>
      </section>
    </div>
  )
}
