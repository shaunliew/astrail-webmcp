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

export const faqs = [
  {
    question: "What does the beta actually do?",
    answer:
      "You give Astrail your saved Reels, dates, budget, and preferences. It returns verified stops, a day-by-day itinerary, route logic, and the reasoning for why each place made the cut.",
  },
  {
    question: "Does it book hotels or flights?",
    answer:
      "Not in the beta. We're focused on getting the planning layer right first: verified places, trustworthy routing, saved trips, and explained decisions. Booking comes later, and only once the planning is good enough to trust.",
  },
  {
    question: "How does the personalization work?",
    answer:
      "Astrail learns your travel style as you use it: pace, budget, food, walking tolerance, neighborhoods you like, things you avoid. The goal is a planner that gets sharper over time without hiding the assumptions it's using.",
  },
  {
    question: "Why start from Reels?",
    answer:
      "Because that's where most travel intent now starts. People save places months before they're ready to plan. Astrail starts from that messy inspiration layer and turns it into a real trip.",
  },
] as const;

export const tallyEmbedUrl =
  "https://tally.so/embed/QKjrvk?alignLeft=1&hideTitle=1&transparentBackground=1&dynamicHeight=1";

export const tallyFallbackUrl = "https://tally.so/r/QKjrvk";
