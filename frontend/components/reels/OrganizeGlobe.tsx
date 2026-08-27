'use client'

import { useEffect, useState } from 'react'

/* The decorative word cycle that used to be the ONLY visible text here is gone.

   It was explicitly "cosmetic motion, never a progress claim", cycling on a timer while the real
   durable-job status rode an sr-only region — so a screen-reader user was told what was happening
   and a sighted user was not. Across a 60-180 second job that leaves no way to tell working from
   stuck, on the exact screen a judge sits through. The status was already being passed in; it
   just was not shown. The constellation below still supplies the motion the words were there for. */

// A small asterism: five stars the line threads into a trail. pathLength=100 normalizes the
// stroke-dash animation so the draw is independent of the actual segment lengths.
const STARS = [
  { cx: 16, cy: 62 },
  { cx: 48, cy: 30 },
  { cx: 80, cy: 54 },
  { cx: 112, cy: 24 },
  { cx: 144, cy: 48 },
]
const TRAIL = 'M16 62 L48 30 L80 54 L112 24 L144 48'

export default function OrganizeGlobe({ message }: { message: string }) {
  /* Elapsed seconds, counted here rather than predicted. A wait with a number moving on it reads
     as alive even while one slow stage holds the message still — and unlike a percentage or an
     ETA, it cannot be wrong: it is a measurement, not a forecast. */
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <main
      data-testid="organize-globe"
      className="relative flex min-h-[100dvh] flex-col items-center justify-center gap-7 overflow-hidden bg-[var(--void)] p-6"
    >
      <svg
        viewBox="0 0 160 86"
        className="w-44 max-w-[70vw]"
        role="img"
        aria-label="Organizing your Reels into a constellation"
      >
        <path className="organize-line" d={TRAIL} pathLength={100} />
        {STARS.map((star, i) => (
          <circle
            key={i}
            className="organize-star"
            cx={star.cx}
            cy={star.cy}
            r={2.6}
            style={{ animationDelay: `${i * 0.26}s` }}
          />
        ))}
      </svg>

      {/* ONE status, seen and heard. `key` restarts the fade on each change so a new stage reads
          as an event rather than text quietly swapping. */}
      <p
        key={message}
        role="status"
        aria-live="polite"
        className="organize-word max-w-[34ch] text-center text-sm tracking-[0.08em] text-[color:var(--starlight)]"
      >
        {message}
      </p>

      <p className="text-xs tabular-nums tracking-[0.08em] text-[color:var(--muted)]">
        {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
        <span className="ml-2 text-[color:var(--faint)]">this usually takes 1&ndash;3 minutes</span>
      </p>
    </main>
  )
}
