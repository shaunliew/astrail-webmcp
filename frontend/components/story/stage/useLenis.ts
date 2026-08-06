'use client'

import { useEffect } from 'react'
import Lenis from 'lenis'

/* Weighted, eased page scrolling — scoped to the landing story only (see
   STACK.md: the app shell must not adopt Lenis). Lenis animates real window
   scroll, so motion's useScroll keeps reading true positions. */
export function useLenis() {
  useEffect(() => {
    // Respect reduced-motion: don't hijack scroll into a weighted glide for
    // users who asked the OS for less motion — leave native scrolling alone.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    const lenis = new Lenis({
      duration: 1.15, // glide weight — tuned by feel
      smoothWheel: true,
    })

    let frame: number
    const raf = (time: number) => {
      lenis.raf(time)
      frame = requestAnimationFrame(raf)
    }
    frame = requestAnimationFrame(raf)

    return () => {
      cancelAnimationFrame(frame)
      lenis.destroy()
    }
  }, [])
}
