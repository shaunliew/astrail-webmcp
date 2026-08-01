'use client'

import { useEffect, useState } from 'react'

// Decorative, on-theme progress words for the organize interstitial. They cycle on a timer
// (NOT per backend stage) — cosmetic motion, never a progress claim. The real durable-job
// status still rides the sr-only role="status" region below, so screen readers hear it.
const ORGANIZE_WORDS = [
  'Stargazing…',
  'Reading your Reels…',
  'Pinning places…',
  'Connecting the dots…',
  'Plotting your trail…',
]

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
  const [wordIndex, setWordIndex] = useState(0)

  // Cycle the decorative word — unless the user prefers reduced motion, where we hold the
  // first word and the CSS freezes the constellation to a static, fully-drawn trail.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setWordIndex((i) => (i + 1) % ORGANIZE_WORDS.length), 1300)
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

      <p key={wordIndex} aria-hidden className="organize-word text-sm tracking-[0.08em] text-[color:var(--starlight)]">
        {ORGANIZE_WORDS[wordIndex]}
      </p>

      {/* The real durable-job status, for screen readers — the visible word above is decorative. */}
      <span role="status" aria-live="polite" className="sr-only">{message}</span>
    </main>
  )
}
