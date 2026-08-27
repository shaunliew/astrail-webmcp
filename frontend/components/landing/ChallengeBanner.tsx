'use client'

import { useEffect, useRef } from 'react'

/**
 * The "this is a challenge build" notice, pinned above everything else on the landing page.
 *
 * It publishes its own height as `--challenge-banner-h` on the document root, and
 * `.story-nav` (position: fixed; top: 0) reads that variable for its own `top`. Without it the
 * banner sits at z-100 directly over the fixed nav and clips it — the nav links were unreachable
 * behind the notice.
 *
 * MEASURED rather than hardcoded, because the height is not a constant: the sentence wraps to two
 * lines below roughly 640px and to three on a small phone, and a fixed offset would either gap on
 * desktop or keep clipping on mobile. A ResizeObserver also covers font loading, which changes the
 * height after first paint.
 */
export default function ChallengeBanner() {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const publish = () => {
      document.documentElement.style.setProperty('--challenge-banner-h', `${el.offsetHeight}px`)
    }
    publish()

    // Guarded: ResizeObserver is absent in jsdom and in older Safari. Its absence costs only the
    // response to a resize, so the banner must still publish its height once without it.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      // The variable is global, and every other page's nav reads the same one. Leaving a stale
      // height behind would push /app's chrome down by the height of a banner that is gone.
      document.documentElement.style.removeProperty('--challenge-banner-h')
    }
  }, [])

  return (
    <aside
      ref={ref}
      role="status"
      aria-label="Challenge build notice"
      className="sticky top-0 z-[100] border-b border-[color:var(--paper-line-2)] bg-[color:var(--night-900)] px-5 py-3 text-center font-[family-name:var(--font-figtree)] text-sm leading-5 text-[color:var(--starlight)] shadow-[0_4px_20px_rgba(10,13,20,0.18)]"
    >
      This is a <b className="font-semibold text-[color:var(--brass-bright)]">WebMCP Challenge</b>{' '}
      build — an experiment in planning trips with an agent, not a product you can sign up for.
    </aside>
  )
}
