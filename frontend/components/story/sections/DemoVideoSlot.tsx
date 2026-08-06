'use client'

import { DEMO_VIDEO_SRC } from '../story-config'
import { STILLS } from '../story-config'

/* Zhi Hao is recording a fresh screen-capture demo. Until it lands, this
   section renders a labeled slot; drop the file in public/landing/ and set
   DEMO_VIDEO_SRC in story-config — nothing else changes. */
export default function DemoVideoSlot() {
  return (
    <section className="bg-[color:var(--paper-1)] px-6 py-24 md:px-12">
      {/* Left-aligned like every other section (this was the page's only
          centered block), and framed with the same browser chrome as the
          HowItWorks screenshots — one card grammar for all product media. */}
      <div className="mx-auto max-w-5xl">
        <p className="story-eyebrow text-[color:var(--story-teal-ink)]">
          Watch it work
        </p>
        <h2 className="story-h text-[color:var(--ink-900)]">
          Sixty seconds, reels to route.
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
          {DEMO_VIDEO_SRC ? (
            <video
              src={DEMO_VIDEO_SRC}
              poster={STILLS.coldOpen}
              controls
              playsInline
              preload="metadata"
              className="block w-full bg-[color:var(--night-900)]"
            />
          ) : (
            <div className="flex aspect-video items-center justify-center bg-[color:var(--paper-2)]">
              <p className="px-6 font-mono text-xs uppercase tracking-[0.14em] text-[color:var(--ink-400)]">
                demo recording lands here &mdash; Zhi Hao is filming
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
