'use client'

import { useState } from 'react'

import { DEMO_YOUTUBE_ID, DEMO_YOUTUBE_URL } from '../story-config'

/* The submission recording, in the same browser-chrome card as the HowItWorks screenshots.
 *
 * Click-to-play rather than a mounted iframe. A YouTube embed on load pulls several hundred KB
 * and sets cookies for every visitor who never presses play, and this section sits well below
 * the fold. The facade is one image until someone asks for the video.
 *
 * `maxresdefault` is not generated for every upload, so a failed load falls back to `hqdefault`,
 * which YouTube always produces. Both hosts are already in `img-src` (next.config.ts), as is
 * `https://www.youtube.com` in `frame-src` — no CSP change was needed for this. */
export default function DemoVideoSlot() {
  const [playing, setPlaying] = useState(false)
  const [poster, setPoster] = useState(
    `https://i.ytimg.com/vi/${DEMO_YOUTUBE_ID}/maxresdefault.jpg`,
  )

  return (
    <section className="bg-[color:var(--paper-1)] px-6 py-24 md:px-12">
      <div className="mx-auto max-w-5xl">
        <p className="story-eyebrow text-[color:var(--story-teal-ink)]">
          Watch it work
        </p>
        <h2 className="story-h text-[color:var(--ink-900)]">
          Under three minutes, reels to route.
        </h2>

        <div className="mt-10 overflow-hidden rounded-xl border border-[color:var(--paper-line)] bg-[color:var(--paper-0)] shadow-[0_1px_2px_rgba(28,23,16,0.08),0_16px_40px_rgba(28,23,16,0.14)]">
          <div className="flex items-center gap-1.5 border-b border-[color:var(--paper-line)] bg-[color:var(--paper-2)] px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--paper-line-2)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--paper-line-2)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--paper-line-2)]" />
            <span className="ml-3 font-mono text-[11px] tracking-wide text-[color:var(--ink-400)]">
              astrail.app
            </span>
          </div>

          <div className="relative aspect-video bg-[color:var(--night-900)]">
            {playing ? (
              <iframe
                src={`https://www.youtube.com/embed/${DEMO_YOUTUBE_ID}?autoplay=1&rel=0&modestbranding=1`}
                title="Astrail, a WebMCP trip planner you operate by talking"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                className="absolute inset-0 h-full w-full border-0"
              />
            ) : (
              <button
                type="button"
                onClick={() => setPlaying(true)}
                aria-label="Play the Astrail demo video"
                className="group absolute inset-0 h-full w-full cursor-pointer"
              >
                <img
                  src={poster}
                  alt=""
                  loading="lazy"
                  /* A 120x90 placeholder is what YouTube serves when maxresdefault is absent,
                     and it loads successfully, so onError never fires. Measure instead. */
                  onLoad={(e) => {
                    if (e.currentTarget.naturalWidth < 400) {
                      setPoster(`https://i.ytimg.com/vi/${DEMO_YOUTUBE_ID}/hqdefault.jpg`)
                    }
                  }}
                  className="absolute inset-0 h-full w-full object-cover transition duration-700 group-hover:scale-[1.015]"
                />
                <span className="absolute inset-0 bg-[linear-gradient(180deg,rgba(10,13,20,0.10),rgba(10,13,20,0.45))] transition group-hover:bg-[linear-gradient(180deg,rgba(10,13,20,0.05),rgba(10,13,20,0.35))]" />
                <span className="absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-[color:var(--brass-bright)] bg-[rgba(10,13,20,0.55)] shadow-[0_0_48px_rgba(224,169,59,0.28)] backdrop-blur transition group-hover:bg-[rgba(224,169,59,0.22)] md:h-20 md:w-20">
                  <span className="ml-1 h-0 w-0 border-y-[11px] border-l-[18px] border-y-transparent border-l-[color:var(--starlight)]" />
                </span>
              </button>
            )}
          </div>
        </div>

        {/* The rules require this video to stay public for the whole judging period, so the page
            names where it lives rather than only embedding it. A judge whose browser blocks the
            iframe still has a way to watch it. */}
        <p className="mt-4 text-[14px] text-[color:var(--ink-400)]">
          Also on YouTube:{' '}
          <a
            href={DEMO_YOUTUBE_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-[color:var(--story-teal-ink)] underline underline-offset-4"
          >
            {DEMO_YOUTUBE_URL.replace('https://', '')}
          </a>
        </p>
      </div>
    </section>
  )
}
