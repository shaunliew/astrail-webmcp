'use client'

import ShotSlot from './ShotSlot'
import { SCREENS } from '../story-config'

/* The trust spine: what Astrail actually does, told with REAL app UI.
   Three steps, real screenshots (no renders, no simulated product). */
const STEPS = [
  {
    eyebrow: 'Step 1',
    title: 'Paste the reels you saved',
    body: 'Drop 1–5 Instagram travel reels, your dates, budget and vibe. That pile of saved inspiration is the input.',
    src: SCREENS.createTrail,
    alt: 'Astrail create-trail form with pasted reel links',
    slotLabel: 'real screenshot — create-trail form',
    note: 'forward reels straight to our Telegram bot and skip the copy-paste',
  },
  {
    eyebrow: 'Step 2',
    title: 'Agents do the research',
    body: 'Astrail extracts every place, verifies it exists, checks weather and routes — and shows its evidence: the source reel, the caption quote, the receipts.',
    src: SCREENS.reelLibrary,
    alt: 'Astrail reel library with verified places and evidence',
    slotLabel: 'real screenshot — reel library / evidence',
  },
  {
    eyebrow: 'Step 3',
    title: 'Get a route you can actually take',
    body: 'A day-by-day itinerary on a real map — grouped by day, connected by transit, every stop traceable back to the reel it came from.',
    src: SCREENS.tripWorkspace,
    alt: 'Astrail trip workspace: itinerary beside the live map',
    slotLabel: 'real screenshot — trip workspace',
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
          From saved reels to a real plan, in one sitting.
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
                      Soon
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
