'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useOptionalWebMcpRegistry } from './WebMcpRegistry'

/**
 * Showing people what to say.
 *
 * The user feedback that motivated this whole integration was "it's unclear how to navigate the
 * website — where to click, how to choose the reels, how to start generating a trip." An agent
 * does not fix that by existing: you cannot ask for a capability you do not know is there. So the
 * app shows the sentences that work.
 *
 * Prompts are context-aware, drawn from the same signal `get_app_state` reads, so they are never
 * wrong for the page you are on.
 */

const STORAGE_KEY = 'astrail:webmcp:prompts-dismissed'

type Prompt = { text: string; why: string }

function promptsFor(pathname: string): Prompt[] {
  if (pathname.startsWith('/app/trip/')) {
    return [
      { text: 'Show me day 2 on the map', why: 'moves the live map' },
      { text: 'Day 2 looks packed — move stop 7 to day 3', why: 'edits the itinerary' },
      { text: 'Why is this place on my trip?', why: 'shows the Reel quote behind it' },
      // Three, not four. `Show the hotel view` used to sit here with a qualifier explaining that
      // it only works on a trip generated before hotel search was switched off. A first-run panel
      // is an on-ramp: a prompt that declines on every trip made since is a bad first thing to
      // try, however honestly it is labelled. Removed rather than replaced — this panel earns
      // nothing by being four items long.
    ]
  }
  return [
    { text: 'What can I do here?', why: 'the agent reads the app and explains it' },
    { text: 'What reels do I have saved?', why: 'lists your library' },
    // These two are deliberately a SEQUENCE, and the wording carries it: "Now" only makes sense
    // after the line above. Saving first and then planning from the library is the flow the agent
    // is best at — it reads the URLs back out of `list_saved_reels` and feeds them to
    // `plan_trip_from_reels`, so the reader never handles a link twice. A single combined prompt
    // works too, but teaches the flow that skips the step people said they could not figure out.
    { text: 'Save these reels: <paste links>', why: 'no more tab-switching' },
    { text: 'Now plan me 3 days in Tokyo, 12–14 December', why: 'uses the reels you just saved' },
  ]
}

export default function ExamplePrompts() {
  const registry = useOptionalWebMcpRegistry()
  const pathname = usePathname() ?? '/app'
  const [dismissed, setDismissed] = useState(true) // assume dismissed until storage is read

  useEffect(() => {
    // localStorage throws in some privacy modes; a remembered dismissal is not worth a crash.
    try {
      setDismissed(window.localStorage.getItem(STORAGE_KEY) === '1')
    } catch {
      setDismissed(false)
    }
  }, [])

  // Pointless in a browser with no agent — it would be telling people to talk to nobody.
  if (!registry?.supported || dismissed) return null

  const dismiss = () => {
    setDismissed(true)
    try { window.localStorage.setItem(STORAGE_KEY, '1') } catch { /* fine, it reappears */ }
  }

  return (
    <div className="pointer-events-auto w-[min(22rem,100%)] rounded-xl border border-white/15 bg-black/85 p-3 text-xs text-white/85 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wider text-[#E8D5B0]">Try asking the agent</p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss example prompts"
          className="-mr-1 -mt-1 rounded px-1.5 text-white/50 transition hover:text-white/90"
        >
          ✕
        </button>
      </div>
      <ul className="space-y-1.5">
        {promptsFor(pathname).map((p) => (
          <li key={p.text}>
            <span className="text-white/90">&ldquo;{p.text}&rdquo;</span>
            <span className="ml-1 text-white/45">— {p.why}</span>
          </li>
        ))}
      </ul>
      {/* Bare, and it stays bare. A recovery hint lived here briefly — "if it starts clicking the
          page instead, ask it to use Astrail's tools" — and it was in the wrong place: a reader
          who has not hit the problem reads a caveat beside the prompts as an admission that the
          integration is flaky, which is a worse impression than the truth. Bare prompts mostly do
          reach the tools, and an agent picking the right one from ordinary language is the thing
          this entry is showing off; hand-holding copy would argue against it.

          The hint now lives in SUBMISSION.md's state-of-each-path table, where someone looks AFTER
          something has not worked. Do not move it back up here. */}
      <p className="mt-2 border-t border-white/10 pt-2 text-[11px] text-white/45">
        Type these in ChatGPT while this page is open.
      </p>
    </div>
  )
}
