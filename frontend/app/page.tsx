import type { Metadata } from "next";

import StoryStage from "@/components/story/stage/StoryStage";

export const metadata: Metadata = {
  title: "Astrail — turn the reels you saved into a route you'll actually take",
  description:
    "Paste the travel reels you saved. Astrail's agents turn them into an evidence-backed itinerary on a real map. Self-funded beta, 25 seats.",
};

// One-Stage proof slice (beats 0→2) under review — the full 8-beat stage
// follows once the transition grammar is approved. Previous sticky-section
// build preserved in components/story/StoryLanding.tsx; old landing at /classic.
export default function LandingPage() {
  return (
    <>
      <aside
        role="status"
        aria-label="Challenge build notice"
        className="sticky top-0 z-[100] border-b border-[color:var(--paper-line-2)] bg-[color:var(--night-900)] px-5 py-3 text-center font-[family-name:var(--font-figtree)] text-sm leading-5 text-[color:var(--starlight)] shadow-[0_4px_20px_rgba(10,13,20,0.18)]"
      >
        This is a WebMCP Challenge build of Astrail — an experiment in planning trips with an
        agent. For the production product, see{' '}
        <a
          href="https://astrail.xyz"
          className="font-semibold text-[color:var(--brass-bright)] underline underline-offset-4"
        >
          astrail.xyz
        </a>
        .
      </aside>

      <div className="bg-[color:var(--paper-1)] px-5 py-12 font-[family-name:var(--font-figtree)] text-[color:var(--ink-900)] sm:px-8 lg:py-16">
        <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-2">
          <section
            aria-labelledby="hackathon-new-heading"
            className="rounded-2xl border border-[color:var(--paper-line)] bg-[color:var(--paper-0)] p-6 shadow-[0_12px_30px_rgba(28,23,16,0.07)] sm:p-8"
          >
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[color:var(--spruce-deep)]">
              Challenge work
            </p>
            <h2
              id="hackathon-new-heading"
              className="font-[family-name:var(--font-fraunces)] text-3xl font-semibold tracking-[-0.02em]"
            >
              What&apos;s new for this hackathon
            </h2>
            <ul className="mt-6 space-y-3 text-[15px] leading-6 text-[color:var(--ink-600)]">
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                A browser-side WebMCP layer that shares the signed-in page&apos;s live state with an agent.
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                <code className="text-[color:var(--ink-900)]">get_app_state</code> tells the agent where the user is and what can happen next.
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                Tools can read saved Reels, trips, itineraries, and the verbatim evidence behind each stop.
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                New actions save Reels, start and track generation, control the live map, and edit a finished route.
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                Owner-checked edit endpoints and contract tests keep agent actions scoped, attributable, and safe.
              </li>
            </ul>
            <a
              href="https://github.com/MalaysiaKaki/astrail/blob/feat/webmcp/docs/webmcp/WHATS-NEW.md"
              className="mt-7 inline-flex font-semibold text-[color:var(--spruce-deep)] underline underline-offset-4"
            >
              Read the full new-vs-pre-existing record
            </a>
          </section>

          <section
            aria-labelledby="judges-heading"
            className="rounded-2xl border border-[color:var(--brass-deep)] bg-[color:var(--paper-2)] p-6 sm:p-8"
          >
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[color:var(--brass-deep)]">
              Test setup
            </p>
            <h2
              id="judges-heading"
              className="font-[family-name:var(--font-fraunces)] text-3xl font-semibold tracking-[-0.02em]"
            >
              For judges
            </h2>
            <ol className="mt-6 space-y-4 text-[15px] leading-6 text-[color:var(--ink-600)]">
              <li><b className="text-[color:var(--ink-900)]">1.</b> Open this URL in the ChatGPT desktop app&apos;s built-in browser, not Safari or Chrome.</li>
              <li><b className="text-[color:var(--ink-900)]">2.</b> Use GPT-5.6 Sol or Terra. Luna has WebMCP disabled.</li>
              <li><b className="text-[color:var(--ink-900)]">3.</b> Turn on <b className="text-[color:var(--ink-900)]">Settings &gt; Browser &gt; Permissions &gt; Enable site tools</b>.</li>
              <li><b className="text-[color:var(--ink-900)]">4.</b> Look for the Site tools arrow in the address bar and the WebMCP chip at the bottom-right of the page.</li>
            </ol>
            <p className="mt-7 rounded-lg border border-dashed border-[color:var(--ink-400)] bg-[color:var(--paper-0)] px-4 py-3 font-[family-name:var(--font-ibm-plex-mono)] text-xs font-medium text-[color:var(--ink-600)]">
              TODO: Demo credentials — add the submission account before judging.
            </p>
          </section>
        </div>
      </div>

      <StoryStage />
    </>
  );
}
