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
      "Not the ones that matter. Planning a trip stops for approval on the page first, and so does every edit to a finished one — moving a stop included, because a move now costs a rewrite. The request is shown to you in full before it is sent, and so is the spending inside it: looking up the coordinates for a stop you asked for is a paid call, and it happens after you accept the card, not before. Exactly one action spends with no card in front of it — saving a Reel starts extracting the places in it. That one is bounded by a daily limit, and it skips a Reel whose places it has already extracted, though a Reel that was saved but never made it through extraction is tried again. Reading is free and stays silent; a confirmation on every click would make the whole thing tiresome to use.",
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
      "No, and in this build it does not even search. Astrail's hotel results came from Travala's travel MCP, which now refuses every call it used to answer, so hotel search is switched off and a trip you generate today comes back with no places to stay — the app hides that panel rather than showing you an empty one, and trips generated before the switch keep the hotels they already have. None of it was ever a booking: no payments, no booking step anywhere in the flow, and a price on a card was a search result, never an offer being held for you.",
  },
] as const;

export const tallyEmbedUrl =
  "https://tally.so/embed/QKjrvk?alignLeft=1&hideTitle=1&transparentBackground=1&dynamicHeight=1";

// Full-launch notify list (hotel booking via Travala). Repurposes the old waitlist form.
export const tallyFallbackUrl = "https://tally.so/r/QKjrvk";

// Inbound alias (Cloudflare Email Routing). Confirm this address is live before launch.
export const contactEmail = "zhihao@astrail.xyz";
