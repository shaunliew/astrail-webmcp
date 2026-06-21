export const navItems = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Proof", href: "#proof" },
] as const;

export const howItWorksSteps = [
  {
    title: "Paste the Reels you saved",
    body: "Bring the scattered links, places, dates, budget, and loose preferences you already have.",
  },
  {
    title: "Astrail verifies the places",
    body: "The planner extracts real stops, researches them, and keeps evidence attached to every recommendation.",
  },
  {
    title: "Get a route you can trust",
    body: "The result is a day-by-day trail with route logic, explained choices, and a saved plan you can revisit.",
  },
] as const;

export const faqs = [
  {
    question: "What does the beta do?",
    answer:
      "Astrail turns saved travel inspiration into a route you can inspect: Reel links, places, dates, budget, and preferences become verified stops, a day-by-day itinerary, route logic, and evidence for why each place belongs.",
  },
  {
    question: "Does Astrail book hotels or flights?",
    answer:
      "Not in the beta. V1 focuses on planning reliability first: verified places, trustworthy routing, saved trips, and explained decisions. Booking comes later only after the planning layer is good enough to trust.",
  },
  {
    question: "What personalization are you building?",
    answer:
      "Astrail is being built to remember your travel style over time: pace, budget, food preferences, walking tolerance, neighborhoods you like, and things you avoid. The goal is a planner that gets better each time without hiding the assumptions it uses.",
  },
  {
    question: "Why start from Reels?",
    answer:
      "Because that is where a lot of travel intent now begins. People save places long before they are ready to plan. Astrail starts from that messy inspiration layer and turns it into something executable.",
  },
] as const;

export const tallyEmbedUrl =
  "https://tally.so/embed/QKjrvk?hideTitle=1&transparentBackground=1&dynamicHeight=1";

export const tallyFallbackUrl = "https://tally.so/r/QKjrvk";
