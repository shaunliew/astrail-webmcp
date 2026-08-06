'use client'

import { STILLS } from '../story-config'

/* The story interlude (ZH, 2026-08-06): the two locked keyframes from the
   metaphor arc — overwhelm and rescue-burst — reintroduced as a two-chapter
   problem→solution beat between the hero and HowItWorks. This is where the
   page says who Aster is and why Astrail exists, in his world, right before
   HowItWorks shows the same rescue on real screens.

   Framing rule: story art gets a plain dark frame, never ShotSlot's browser
   chrome — renders must not dress up as product UI. */
const CHAPTERS = [
  {
    eyebrow: 'Chapter one · The pile',
    title: 'Saved is where trips go to sleep.',
    body: 'Every star in Aster’s pile is a saved reel — a café in Tokyo, a viewpoint you swore you’d get to. Saving feels like progress, but the pile only grows: forty reels deep, still no dates, no route, no trip. That look on his face is the moment you reopen your saved folder and don’t know where to start.',
    src: STILLS.overwhelm,
    alt: 'Aster, Astrail’s shiba-astronaut navigator, buried to his chest in a glowing pile of yellow and blue star cushions, looking worn out',
  },
  {
    eyebrow: 'Chapter two · The rescue',
    title: 'Astrail is the machine that digs you out.',
    body: 'It’s the mech Aster pilots: a crew of AI agents that bursts through the backlog for you. Feed it the reels you saved and it watches every one, pulls out each real place, verifies it on the map, and keeps the receipts — until your scattered stars come back as one route you can actually take.',
    src: STILLS.rescueBurst,
    alt: 'A joyful Aster piloting the boxy Astrail mech as it bursts through a wall of star cushions, the star-collector jar on its back glowing',
  },
] as const

export default function AsterStory() {
  return (
    <section
      id="story"
      className="px-6 py-24 md:px-12"
      style={{
        background:
          'linear-gradient(to bottom, var(--story-dusk), var(--night-900))',
      }}
    >
      <div className="mx-auto max-w-6xl">
        <p className="story-eyebrow text-[color:var(--story-teal-night)]">
          The story behind Astrail
        </p>
        <h2 className="story-h max-w-[24ch] text-[color:var(--starlight)]">
          Every trip starts as a pile of saved reels.
        </h2>
        <p className="story-sub max-w-[38em] text-[color:var(--starlight-70)]">
          This is Aster, Astrail&rsquo;s navigator &mdash; a shiba who hoards
          travel inspiration the way we all do: one glowing save at a time.
        </p>

        <div className="mt-14 flex flex-col gap-20">
          {CHAPTERS.map((chapter, i) => (
            <div
              key={chapter.eyebrow}
              className={`flex flex-col items-center gap-10 md:gap-14 ${
                i % 2 ? 'md:flex-row-reverse' : 'md:flex-row'
              }`}
            >
              <div className="md:w-2/5">
                <p className="story-eyebrow text-[color:var(--brass-bright)]">
                  {chapter.eyebrow}
                </p>
                <h3 className="story-h [font-size:clamp(1.6rem,2.6vw,2.2rem)] text-[color:var(--starlight)]">
                  {chapter.title}
                </h3>
                <p className="story-sub text-[color:var(--starlight-70)]">
                  {chapter.body}
                </p>
              </div>
              <figure className="overflow-hidden rounded-xl border border-[color:var(--night-line)] shadow-[inset_0_1px_0_rgba(247,243,232,0.07),0_1px_2px_rgba(0,0,0,0.55),0_8px_28px_rgba(0,0,0,0.4)] md:w-3/5">
                {/* 1920x1072 keyframe — reserve the ratio so the lazy image
                    never causes a layout jump when it lands. */}
                <img
                  src={chapter.src}
                  alt={chapter.alt}
                  className="block aspect-[1920/1072] w-full object-cover"
                  loading="lazy"
                />
              </figure>
            </div>
          ))}
        </div>

        {/* Honest hand-off: the chapters are illustrations; the proof is the
            real product right below. */}
        <p className="story-sub mt-16 max-w-[38em] text-[color:var(--starlight-70)]">
          That&rsquo;s the story. Below is the real thing &mdash;{' '}
          <a
            href="#how-it-works"
            className="font-semibold text-[color:var(--story-teal-night)] underline underline-offset-4"
          >
            actual product screens, no renders
          </a>
          .
        </p>
      </div>
    </section>
  )
}
