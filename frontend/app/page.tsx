import type { Metadata } from "next";

import ChallengeBanner from "@/components/landing/ChallengeBanner";
import StoryStage from "@/components/story/stage/StoryStage";

export const metadata: Metadata = {
  title: "Astrail — a WebMCP Challenge build",
  description:
    "A trip planner an agent can operate. 16 WebMCP tools let an agent read the signed-in page, save Instagram Reels, run a generation, drive the live map, and restructure a finished route — every stop still saying where it came from: the Reel caption, Astrail's own reasoning, or you.",
};

// One-Stage proof slice (beats 0→2) under review — the full 8-beat stage
// follows once the transition grammar is approved. Previous sticky-section
// build preserved in components/story/StoryLanding.tsx; old landing at /classic.
/* THE JUDGE CREDENTIALS ARE NOT READ HERE, AND MUST NOT BE ADDED BACK.
   This page used to render them from `NEXT_PUBLIC_DEMO_EMAIL` / `NEXT_PUBLIC_DEMO_PASSWORD`.
   `NEXT_PUBLIC_*` is INLINED INTO THE CLIENT BUNDLE at build time, so those values were readable
   out of the shipped JavaScript by anyone, whether or not a component printed them — deleting the
   markup would not have been a fix. The reads had to go, and the deployment sets neither var. It
   is a working login to an account that spends real Apify and OpenAI credit.

   Judges get the credentials from Devpost's private testing-instructions field, which only Devpost
   and the judges can see. Nothing about them belongs in this repository. */
export default function LandingPage() {
  return (
    <>
      <ChallengeBanner />

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
                <span className="min-w-0">
                  <b className="text-[color:var(--ink-900)]">17 tools</b> registered with{' '}
                <code className="break-all text-[color:var(--ink-900)]">document.modelContext.registerTool()</code> — 13 anywhere in the app, 3 more that appear only once a map exists to drive.
                </span>
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                <span className="min-w-0">
                  <code className="text-[color:var(--ink-900)]">get_app_state</code> answers &ldquo;what can I do here?&rdquo; — the fix for the one thing testers kept saying, that they could not tell where to click.
                </span>
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                <span className="min-w-0">
                  The agent can read your saved Reels, your trips, any day&apos;s itinerary, and why a given stop is on it &mdash; the <b className="text-[color:var(--ink-900)]">verbatim caption</b> where the stop came from a Reel, Astrail&apos;s own reasoning where it suggested one, and a plain &ldquo;you asked for this&rdquo; where you did.
                </span>
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                <span className="min-w-0">
                  It can also act: save Reels, start a 60&ndash;180 second generation and narrate each stage, fly and tilt the live map, and move, remove, add or re-plan stops on a finished route.
                </span>
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                <span className="min-w-0">
                  The map was rebuilt to be worth driving: every stop that came from a Reel carries <b className="text-[color:var(--ink-900)]">that Reel&apos;s own cover frame</b> in its pin, and links back to the Reel itself &mdash; never to a scraped directory page.
                </span>
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                <span className="min-w-0">
                  Planning a trip and every edit to a finished one stop for approval on the page first &mdash; including the paid coordinate lookup behind a stop you asked for &mdash; and the edit endpoints behind them are owner-checked, flag-gated and status-guarded. Saving a Reel is the one action that spends with no card in front of it: bounded by a daily limit, and skipped for a Reel whose places are already extracted.
                </span>
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                <span className="min-w-0">
                  Where a fact does not exist, nothing is shown in its place. No invented opening hours, no borrowed photographs, and no Reel cited for a stop that did not come from one.
                </span>
              </li>
            </ul>
            <a
              href="https://github.com/shaunliew/astrail-webmcp/blob/main/docs/webmcp/WHATS-NEW.md"
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
            <div className="mt-7 rounded-lg border border-[color:var(--spruce-deep)] bg-[color:var(--paper-0)] px-4 py-4 text-sm leading-6 text-[color:var(--ink-600)]">
              <p className="font-semibold text-[color:var(--spruce-deep)]">Signing in</p>
              <p className="mt-2">
                The test account&rsquo;s email and password are in the{' '}
                <b className="text-[color:var(--ink-900)]">testing instructions on our Devpost submission</b>, which only
                Devpost and the judges can see. They are deliberately not on this page: anything this
                site could print, it would also ship inside its public JavaScript.
              </p>
              <p className="mt-2">
                Nothing needs an account to look at &mdash; the sample trail above opens signed out,
                with six of the sixteen tools.
              </p>
            </div>
          </section>
        </div>
      </div>

      <StoryStage />
    </>
  );
}
