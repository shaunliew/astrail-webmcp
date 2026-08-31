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
      // Honest about WHEN it works. Hotel search is off in this build, so the hub layer has
      // something to draw only on a trip generated before the switch — the sample trail included.
      // On a trip the reader just made, `set_map_mode` declines and says why. The panel claims
      // above that its prompts are never wrong for the page you are on; this is the one that
      // could be, so it says so rather than sending someone at a decline.
      { text: 'Show the hotel view', why: 'switches the map layer — older trips only, hotel search is off' },
    ]
  }
  return [
    { text: 'What can I do here?', why: 'the agent reads the app and explains it' },
    { text: 'What reels do I have saved?', why: 'lists your library' },
    { text: 'Save these reels: <paste links>', why: 'no more tab-switching' },
    { text: 'Plan me 4 days in Kyoto, 14–17 March', why: 'builds a trip from your reels' },
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
      {/* Said once, here, where the prompts are — not stitched into the prompts themselves. The
          sentences stay the sentences you would actually say; an entry whose whole claim is that
          you talk to the app normally cannot hand people an incantation to recite.

          Deliberately advice for a thing that MAY happen, never a rule about how ChatGPT behaves:
          it was observed choosing browser control over the tools on a bare prompt, and nobody has
          tested whether saying so once holds for the rest of a conversation. Claiming it does
          would be a claim about someone else's product that we cannot support. */}
      <p className="mt-2 border-t border-white/10 pt-2 text-[11px] leading-4 text-white/45">
        Type these in ChatGPT while this page is open. If it starts clicking the page instead of
        using Astrail&rsquo;s own tools, say so and ask it to use them &mdash; which tool it
        reaches for is ChatGPT&rsquo;s call, not something a site decides.
      </p>
    </div>
  )
}
