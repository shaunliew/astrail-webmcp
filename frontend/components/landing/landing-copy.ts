export const navItems = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Proof", href: "#proof" },
] as const;

export const howItWorksSteps = [
  {
    title: "Paste the Reels you saved",
    body: "Drop in the links, your dates, your budget, and any preferences you already have. Messy is fine.",
  },
  {
    title: "Astrail verifies the places",
    body: "We pull the real stops out of each Reel, research them, and keep the evidence attached to every recommendation.",
  },
  {
    title: "Get a route you can follow",
    body: "You get a day-by-day plan with route logic, the reasoning behind each stop, and a saved trip you can come back to.",
  },
] as const;

/* Rewritten for the WebMCP Challenge deployment. The previous set answered "should I join this
   beta" — seats, pricing, what ships later — which is the wrong question to leave in front of a
   judge evaluating an experiment. These answer "what did they build, and can I trust it". */
export const faqs = [
  {
    question: "What is this?",
    answer:
      "A WebMCP Challenge build of Astrail, a planner that turns saved Instagram Reels into a routed, evidence-backed itinerary. The challenge work is the layer that lets an agent operate that planner directly — reading the page you are signed into, and acting on it — rather than you clicking through it alone.",
  },
  {
    question: "What can the agent actually do?",
    answer:
      "Sixteen tools. It can tell you what is possible from where you are, read your saved Reels and any day of an itinerary, quote the caption a stop came from, save new Reels, start a generation and narrate each stage as it runs, fly and tilt the map, and move, remove, add or re-plan stops on a finished route.",
  },
  {
    question: "Can it do things without asking me?",
    answer:
      "Not the ones that matter. Anything that spends money or cannot be undone stops for approval on the page first, and the request is shown to you in full before anything is sent. Reading is free and reversible actions just happen — a confirmation on every click would make the whole thing tiresome to use.",
  },
  {
    question: "What stops it inventing things?",
    answer:
      "Structure, not instructions. Every place comes from a real geocoded record and the agent picks from that list by index, so it has no way to emit a location that does not exist. Where a fact is simply absent — opening hours we cannot source, a photo nobody published — the space stays empty rather than being filled with something plausible.",
  },
  {
    question: "Why start from Reels?",
    answer:
      "Because that is where most travel intent now starts. People save places months before they are ready to plan. Astrail starts from that messy pile of saves and turns it into a real trip — and every stop keeps a link back to the Reel it came from, not to a directory page that happens to mention it.",
  },
  {
    question: "Does it book hotels or flights?",
    answer:
      "No. Hotel results come from a live search and are shown with their price and cancellation terms, but Astrail does not take payments and there is no booking step anywhere in the flow. A price on a card is a search result, not an offer being held for you.",
  },
] as const;

export const tallyEmbedUrl =
  "https://tally.so/embed/QKjrvk?alignLeft=1&hideTitle=1&transparentBackground=1&dynamicHeight=1";

// Full-launch notify list (hotel booking via Travala). Repurposes the old waitlist form.
export const tallyFallbackUrl = "https://tally.so/r/QKjrvk";

// Inbound alias (Cloudflare Email Routing). Confirm this address is live before launch.
export const contactEmail = "zhihao@astrail.xyz";
