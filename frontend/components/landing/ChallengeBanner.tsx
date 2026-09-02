'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'

/**
 * The path a signed-out judge can actually open. EXACT string, never a prefix or a suffix:
 * `middleware.ts` allowlists this literal, so a trailing slash or a query string is a different
 * string to that guard and bounces the visitor to /sign-in.
 */
const SAMPLE_TRAIL_PATH = '/app/trip/demo'

/**
 * The "this is a challenge build" notice, pinned above everything else on the landing page.
 *
 * It also carries the one link a judge with no account can use. That link lives HERE rather than
 * in the "For judges" card because this notice is sticky and first: on a phone the two-column
 * hackathon grid stacks and the judges' card falls below a seven-bullet card, and the story deck
 * below it opens at 100dvh. This is the only element on the page guaranteed to be on screen in
 * the first ten seconds, and it stays on screen after that. It is not a competing CTA — the
 * notice had no link at all, and the hero's "Sign in to try it" and the waitlist are untouched.
 * It completes the sentence it sits next to: nothing to sign up for, so here is the thing itself.
 *
 * The label promises only what any browser delivers — a finished trail on the map, with its
 * evidence. NOT the agent: WebMCP tools appear only in ChatGPT's built-in browser or Chrome 149+,
 * and that requirement is stated once, in the "For judges" card, which is the card about setup.
 * Saying "try the agent" here and handing a Safari judge a static page would be worse than saying
 * nothing.
 *
 * It publishes its own height as `--challenge-banner-h` on the document root, and
 * `.story-nav` (position: fixed; top: 0) reads that variable for its own `top`. Without it the
 * banner sits at z-100 directly over the fixed nav and clips it — the nav links were unreachable
 * behind the notice.
 *
 * MEASURED rather than hardcoded, because the height is not a constant: the sentence wraps to two
 * lines below roughly 640px and to three on a small phone, and the link below it wraps again, so a
 * fixed offset would either gap on desktop or keep clipping on mobile. A ResizeObserver also covers
 * font loading, which changes the height after first paint.
 *
 * The row is capped at max-w-5xl deliberately: the sentence and the link together measure ~1070px,
 * so they wrap to two rows at EVERY width rather than snapping between one row and two as the
 * window crosses some threshold. A banner whose height jumps would drag the fixed nav with it.
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
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-center gap-x-5 gap-y-2 sm:flex-row sm:flex-wrap">
        <p className="min-w-0">
          This is a <b className="font-semibold text-[color:var(--brass-bright)]">WebMCP Challenge</b>{' '}
          build of Astrail, an experiment in planning trips with an agent.
        </p>
        {/* prefetch off: this notice is in the viewport from first paint, and the sample trail
            pulls the map workspace. Warming that behind the story deck's scroll animation costs
            the landing page more than it saves the one judge who clicks. */}
        <Link
          href={SAMPLE_TRAIL_PATH}
          prefetch={false}
          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[color:var(--brass-bright)] px-4 py-1.5 font-semibold text-[color:var(--brass-bright)] transition-colors hover:bg-[color:var(--brass-bright)] hover:text-[color:var(--night-900)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-bright)]"
        >
          See a finished trip, no account needed
          <span aria-hidden>&rarr;</span>
        </Link>
      </div>
      <p className="mt-2 text-xs leading-5 text-[color:var(--muted)]">
        A real generated trail, free to open, in any browser.
      </p>
    </aside>
  )
}
