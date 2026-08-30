export const navItems = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Proof", href: "#proof" },
] as const;

/* Rewritten for the WebMCP Challenge build, for the same reason the FAQ below was. These steps
   described an app you OPERATE — paste, wait, receive — in an entry about an app you WORK WITH.
   Each step now names both hands: what you bring, and what the agent does with it. */
export const howItWorksSteps = [
  {
    title: "Bring the Reels, not a brief",
    body: "Drop in 1-5 links, your dates and your budget, messy as they come — or open Astrail in ChatGPT and just say it. The agent calls the same tool the save button does, so talking to it and clicking through it are one app, not two products.",
  },
  {
    title: "Watch it work, not a spinner",
    body: "Astrail pulls the real places out of each Reel, drops any it cannot verify, and orders them into days that make sense on a map. Ask the agent to start it and you get the run narrated — the stage it is on, what it kept, what it dropped — instead of two minutes of nothing.",
  },
  {
    title: "Change it by saying so",
    body: "“Day 2 is packed — move stop 7 to day 3.” Astrail asks on the page before it commits, the route redraws while you watch, and it rewrites the day summaries itself so the prose never describes a trip you no longer have. Every stop still says where it came from.",
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
