'use client'

import { useRef } from 'react'
import { useScroll } from 'motion/react'

/* One beat = a tall wrapper with a sticky 100vh scene inside. This hook hands
   the beat its own 0→1 progress across the wrapper's full scroll span — the
   single number that drives both the visual playhead and the copy reveals. */
export function useBeatProgress<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null)
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end end'],
  })
  return { ref, progress: scrollYProgress }
}
