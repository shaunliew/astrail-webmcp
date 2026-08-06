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
  return <StoryStage />;
}
