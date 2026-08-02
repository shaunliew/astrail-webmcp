'use client'

import { motion, useScroll, useSpring } from 'motion/react'

/* The constellation-trail progress rail (§9: the visitor always knows where
   they are). Nine star-stops joined by a line that draws with overall scroll. */
const STOPS = 9

export default function StoryProgress() {
  const { scrollYProgress } = useScroll()
  const drawn = useSpring(scrollYProgress, { stiffness: 140, damping: 28 })

  return (
    <div className="story-progress" aria-hidden>
      <svg width="14" height="100%" viewBox="0 0 14 100" preserveAspectRatio="none">
        <line x1="7" y1="2" x2="7" y2="98" stroke="rgba(140,133,120,0.35)" strokeWidth="1" />
        <motion.line
          x1="7"
          y1="2"
          x2="7"
          y2="98"
          stroke="var(--brass-bright)"
          strokeWidth="1.5"
          style={{ pathLength: drawn }}
          strokeLinecap="round"
        />
        {Array.from({ length: STOPS }, (_, i) => {
          const y = 2 + (96 * i) / (STOPS - 1)
          return (
            <circle
              key={i}
              cx="7"
              cy={y}
              r="1.6"
              fill="var(--brass-bright)"
              opacity="0.85"
            />
          )
        })}
      </svg>
    </div>
  )
}
