import type { Metadata } from "next";

import ChallengeBanner from "@/components/landing/ChallengeBanner";
import StoryStage from "@/components/story/stage/StoryStage";

export const metadata: Metadata = {
  title: "Astrail, a WebMCP Challenge build",
  description:
    "A trip planner an agent can operate. 17 WebMCP tools let an agent read the signed-in page, save Instagram Reels, run a generation, drive the live map, and restructure a finished route, with every stop still saying where it came from: the Reel caption, Astrail's own reasoning, or you.",
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
      <StoryStage />
    </>
  );
}
