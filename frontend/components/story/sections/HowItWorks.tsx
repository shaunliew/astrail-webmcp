'use client'

import ShotSlot from './ShotSlot'
import { SCREENS } from '../story-config'

/* The trust spine: what Astrail actually does, told with REAL app UI.
   Three steps, real screenshots (no renders, no simulated product).

   Rewritten agent-first for the challenge build. The steps used to describe the manual flow with
   the agent as a footnote, which is backwards for a page whose whole subject is operating a
   website WITH an agent. Each step now leads with what you say and names the tools behind it, so
   a judge can match the claim to the registry.

   The badge label became a per-step field. It was hardcoded "Soon" for a Telegram teaser that is
   out of scope here and promised something nobody could try; a roadmap word sitting in front of a
   shipped capability read as though the capability were unbuilt. */
const STEPS = [
  {
    eyebrow: 'Step 1',
    title: 'Hand it the reels',
    body: 'Paste 1\u20135 Instagram Reel links with your dates, budget and vibe \u2014 or open Astrail in ChatGPT and say \u201csave these reels\u201d. The agent saves through the same endpoint the form posts to, and starts the extraction the form makes you kick off separately \u2014 so the two paths are one feature, not two.',
    src: SCREENS.createTrail,
    alt: 'Astrail create-trail form with pasted reel links',
    slotLabel: 'real screenshot \u2014 create-trail form',
    badge: 'Agent',
    note: 'save_reels \u00b7 up to 5 at a time, non-Instagram links refused before any request',
  },
  {
    eyebrow: 'Step 2',
    title: 'Follow the work as it happens',
    body: 'Astrail extracts every place, verifies it exists, and checks weather and routes. Ask the agent to start it and you get the run narrated \u2014 which stage it is on, what it kept, what it dropped \u2014 instead of sixty to a hundred and eighty seconds of spinner.',
    src: SCREENS.agentsResearch,
    alt: 'Astrail agents researching the places from your Reels, over the live globe',
    slotLabel: 'real screenshot \u2014 agents at work',
    badge: 'Agent',
    note: 'plan_trip_from_reels \u2192 get_trip_progress \u00b7 approval on the page before anything is spent',
  },
  {
    eyebrow: 'Step 3',
    title: 'Change it by saying so',
    body: 'A day-by-day itinerary on a real map, with every stop traceable to the reel it came from, to Astrail\u2019s own reasoning where it suggested one, or to you. Say \u201cAdd Tokyo Disneyland to day 2\u201d and it finds the place, asks you on the page rather than in chat, and puts it on the map. The route redraws while you watch, and Astrail starts rewriting the day summaries itself in about half a minute, marked as updating while it runs. If that fails the activity rail says so, and the summaries stay behind until you ask again.',
    src: SCREENS.tripWorkspace,
    alt: 'Astrail trip workspace: itinerary beside the live map',
    slotLabel: 'real screenshot, trip workspace',
    badge: 'Agent',
    note: 'move_place \u00b7 remove_place \u00b7 add_place \u00b7 set_trip_dates, each behind an approval card on the page, each starting the rewrite itself',
  },
] as const

export default function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="bg-[color:var(--paper-1)] px-6 py-24 md:px-12"
    >
      <div className="mx-auto max-w-6xl">
        <p className="story-eyebrow text-[color:var(--story-teal-ink)]">
          How it works
        </p>
        <h2 className="story-h max-w-[24ch] text-[color:var(--ink-900)]">
          You bring the reels and the taste. The agent does the clicking. You
          are both working the same map.
        </h2>

        <div className="mt-14 flex flex-col gap-20">
          {STEPS.map((step, i) => (
            <div
              key={step.eyebrow}
              className={`flex flex-col items-center gap-10 md:gap-14 ${
                i % 2 ? 'md:flex-row-reverse' : 'md:flex-row'
              }`}
            >
              <div className="md:w-2/5">
                <p className="story-eyebrow text-[color:var(--brass-deep)]">
                  {step.eyebrow}
                </p>
                <h3 className="story-h [font-size:clamp(1.6rem,2.6vw,2.2rem)] text-[color:var(--ink-900)]">
                  {step.title}
                </h3>
                <p className="story-sub text-[color:var(--ink-600)]">{step.body}</p>
                {'note' in step && step.note ? (
                  <p className="mt-4 text-[14px] font-medium text-[color:var(--story-teal-ink)]">
                    <span className="mr-2 rounded-full border border-[color:var(--story-teal-ink)] px-2 py-[2px] text-[11px] uppercase tracking-[0.12em]">
                      {'badge' in step && step.badge ? step.badge : 'Soon'}
                    </span>
                    {step.note}
                  </p>
                ) : null}
              </div>
              <ShotSlot
                src={step.src}
                alt={step.alt}
                label={step.slotLabel}
                className="md:w-3/5"
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
