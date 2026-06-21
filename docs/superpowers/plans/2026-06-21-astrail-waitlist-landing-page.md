# Astrail Waitlist Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Astrail waitlist landing page at `frontend/app/page.tsx` as a premium cinematic, mobile-safe, waitlist-first page that converts X traffic into Tally email signups.

**Architecture:** The root route (`/`) remains a marketing page. Landing-specific components live under `frontend/components/landing/` and do not mix with `/app` product components. Cinematic visuals are isolated in client-only leaf components, with static/reduced-motion fallbacks so page content and the Tally form remain usable if WebGL fails.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind v4, TypeScript, Three.js for landing-only hero/pain visuals, Tally embed for email capture, optional Docker Compose for local frontend dev.

---

## Non-Negotiable Working Rule

Do not implement the full website in one pass.

Each checkpoint ends with:

1. Run the verification commands listed in that checkpoint.
2. Start or keep the dev server running.
3. Capture desktop and mobile screenshots.
4. Show the user the result.
5. Wait for explicit approval before continuing.

If a checkpoint is rejected, adjust that checkpoint only. Do not jump ahead.

---

## Product And Design Decisions Already Locked

- Primary goal: collect beta waitlist emails from X/build-in-public traffic.
- Audience: people who save many travel Reels but never execute trips, plus AI/build-in-public followers.
- Page style: premium cinematic travel tool, not generic AI SaaS.
- First viewport: cinematic Milky Way + poetic scattered-stars metaphor.
- Hero copy direction: "Your saved travel Reels are scattered stars. Astrail draws the trail."
- Hero motion: auto-forming constellation on load, subtle cursor discovery after formation.
- Hero CTA: button only, no form in hero.
- Typography: editorial premium, using Spectral for display, Inter for UI/body, JetBrains Mono for labels.
- Pain headline: "Inspiration is easy. Execution is broken."
- Pain visual: soft vertical light shards that imply saved Reels without showing fake Instagram UI.
- How it works: hybrid poetic headline + product-led steps.
- How it works visual: one continuous constellation path, not three generic cards.
- Proof: demo theater first, award photo as restrained proof receipt.
- Founder story: from both builders, emotional plus product-led.
- Waitlist: quiet founder invitation, inline Tally email-only embed.
- FAQ: after waitlist, short and strategic.
- Navigation: Astrail, How it works, Proof, Join waitlist.
- AI language: light mention only. Avoid "AI-powered", "next-gen", "seamless", "unlock", "unleash".
- Color: black/warm-white/brass UI, subtle blue/cyan only inside Milky Way dust.
- Three.js exception: landing page only. No Three.js in product app/trip UI.
- Mobile: prioritize UX over spectacle.

---

## File Structure To Create Or Modify

### Frontend Foundation

- Create `frontend/package.json`
  - Restores real package metadata for Vercel and Docker.
  - Adds `dev`, `build`, `start`, and `typecheck` scripts.
  - Declares the currently used Next/React/Tailwind stack plus Three.js.

- Create `frontend/next.config.ts`
  - Minimal Next config.

- Create `frontend/tsconfig.json`
  - Standard strict-ish Next TypeScript config.

- Create `frontend/postcss.config.mjs`
  - Tailwind v4 config using `@tailwindcss/postcss`.

- Create `frontend/app/globals.css`
  - Global tokens, font variables, base reset, and landing utilities.

- Modify `frontend/app/layout.tsx`
  - Import `globals.css`.
  - Add metadata.
  - Load Google fonts via `next/font/google` or stable CSS import.

### Landing Page Route

- Modify `frontend/app/page.tsx`
  - Server component.
  - Imports static landing sections and client visual components.
  - Keeps root route marketing-only.

### Landing Components

- Create `frontend/components/landing/landing-copy.ts`
  - Central copy and section data.

- Create `frontend/components/landing/LandingNav.tsx`
  - Minimal nav and smooth anchor links.

- Create `frontend/components/landing/HeroSection.tsx`
  - Server component shell for hero copy and CTA.

- Create `frontend/components/landing/GalaxyConstellation.tsx`
  - Client component.
  - Three.js Milky Way particles and auto-forming constellation.
  - Reduced-motion/static fallback.

- Create `frontend/components/landing/PainSection.tsx`
  - "Inspiration is easy. Execution is broken."
  - Integrates soft light shard visual.

- Create `frontend/components/landing/LightShards.tsx`
  - Client component or CSS-only visual, depending on checkpoint decision.

- Create `frontend/components/landing/HowItWorksSection.tsx`
  - Continuous constellation path with three product-led steps.

- Create `frontend/components/landing/ScrollTrail.tsx`
  - SVG/CSS scroll path, not heavy Three.js.

- Create `frontend/components/landing/ProofSection.tsx`
  - YouTube embed and restrained award proof.

- Create `frontend/components/landing/FounderSection.tsx`
  - Both-builders founder note.

- Create `frontend/components/landing/WaitlistSection.tsx`
  - Inline Tally embed and fallback link.

- Create `frontend/components/landing/FAQSection.tsx`
  - Short FAQ.

- Create `frontend/components/landing/Footer.tsx`
  - Minimal footer, no dead Privacy/Terms links unless real links exist.

### Assets

- Use existing `frontend/public/SeaXOpenAI.jpg`.
- Optionally copy to `frontend/public/landing/seaxopenai-award.jpg` for clearer organization.

### Local Development

- Create `frontend/Dockerfile.dev`
  - Frontend dev container.

- Create root `docker-compose.yml`
  - Frontend service first.
  - Backend service can be included only if it runs with existing env requirements; do not block landing work on backend.

---

## Checkpoint 0: Frontend Build And Dev Foundation

**Purpose:** Make the frontend buildable and deployable before visual work.

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/next.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/postcss.config.mjs`
- Create: `frontend/app/globals.css`
- Modify: `frontend/app/layout.tsx`
- Create: `frontend/Dockerfile.dev`
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `frontend/package.json`**

Use exact stack versions already present in `frontend/node_modules` where possible, plus Three.js for the landing-only visual exception.

```json
{
  "name": "astrail-frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tailwindcss/postcss": "4.3.1",
    "mapbox-gl": "3.24.0",
    "next": "15.5.19",
    "postcss": "^8.5.0",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "tailwindcss": "4.3.1",
    "three": "^0.180.0"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "5.9.3"
  }
}
```

- [ ] **Step 2: Create `frontend/next.config.ts`**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

- [ ] **Step 3: Create `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create `frontend/postcss.config.mjs`**

```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

- [ ] **Step 5: Create `frontend/app/globals.css`**

```css
@import "tailwindcss";

:root {
  --void: #060818;
  --deep: #0E1428;
  --elevated: #1A2140;
  --line: #2D3558;
  --starlight: #F2ECE0;
  --muted: rgba(242, 236, 224, 0.55);
  --faint: rgba(242, 236, 224, 0.25);
  --brass: #C9974E;
  --brass-soft: rgba(201, 151, 78, 0.15);
  --paper: #F2ECE0;
  --ink: #060818;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
  background: var(--void);
}

body {
  margin: 0;
  min-width: 320px;
  background: var(--void);
  color: var(--starlight);
  font-family: var(--font-inter), system-ui, sans-serif;
}

button,
a {
  -webkit-tap-highlight-color: transparent;
}

::selection {
  background: rgba(201, 151, 78, 0.28);
  color: var(--starlight);
}
```

- [ ] **Step 6: Modify `frontend/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Spectral } from "next/font/google";
import "./globals.css";

const spectral = Spectral({
  subsets: ["latin"],
  variable: "--font-spectral",
  weight: ["300", "400", "500"],
  style: ["normal", "italic"],
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["300", "400", "500", "600"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  weight: ["300", "400", "500"],
});

export const metadata: Metadata = {
  title: "Astrail - Your travel Reels, finally a route",
  description:
    "Astrail turns saved travel inspiration into a route you can trust. Every place researched. Every choice explained.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${spectral.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 7: Create `frontend/Dockerfile.dev`**

```dockerfile
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0"]
```

- [ ] **Step 8: Create root `docker-compose.yml`**

```yaml
services:
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile.dev
    ports:
      - "3000:3000"
    volumes:
      - ./frontend:/app
      - /app/node_modules
    environment:
      NEXT_PUBLIC_BACKEND_URL: http://localhost:8000
```

- [ ] **Step 9: Install dependencies**

Run from `frontend/`:

```powershell
npm install
```

Expected:
- `frontend/package-lock.json` is created.
- `frontend/node_modules/three` exists.

- [ ] **Step 10: Verify typecheck and build**

Run from `frontend/`:

```powershell
npm run typecheck
npm run build
```

Expected:
- Typecheck exits 0.
- Next build exits 0.

- [ ] **Checkpoint 0 Review Gate**

Show:
- `npm run build` result.
- Current root page still loads, even if empty.
- Docker command status:

```powershell
docker compose config
```

Stop for user approval.

---

## Checkpoint 1: Static Page Skeleton And Copy

**Purpose:** Establish content hierarchy and section layout before cinematic implementation.

**Files:**
- Create: `frontend/components/landing/landing-copy.ts`
- Create: `frontend/components/landing/LandingNav.tsx`
- Create: `frontend/components/landing/HeroSection.tsx`
- Create: `frontend/components/landing/PainSection.tsx`
- Create: `frontend/components/landing/HowItWorksSection.tsx`
- Create: `frontend/components/landing/ProofSection.tsx`
- Create: `frontend/components/landing/FounderSection.tsx`
- Create: `frontend/components/landing/WaitlistSection.tsx`
- Create: `frontend/components/landing/FAQSection.tsx`
- Create: `frontend/components/landing/Footer.tsx`
- Modify: `frontend/app/page.tsx`

- [ ] **Step 1: Create landing copy source**

`frontend/components/landing/landing-copy.ts`:

```ts
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
```

- [ ] **Step 2: Build static components with no Three.js yet**

Each component should be plain TSX and use existing tokens. No animation beyond CSS hover/fade. This checkpoint validates story and content order.

- [ ] **Step 3: Compose `frontend/app/page.tsx`**

```tsx
import FAQSection from "@/components/landing/FAQSection";
import Footer from "@/components/landing/Footer";
import FounderSection from "@/components/landing/FounderSection";
import HeroSection from "@/components/landing/HeroSection";
import HowItWorksSection from "@/components/landing/HowItWorksSection";
import LandingNav from "@/components/landing/LandingNav";
import PainSection from "@/components/landing/PainSection";
import ProofSection from "@/components/landing/ProofSection";
import WaitlistSection from "@/components/landing/WaitlistSection";

export default function LandingPage() {
  return (
    <main className="min-h-[100dvh] overflow-hidden bg-[var(--void)] text-[var(--starlight)]">
      <LandingNav />
      <HeroSection />
      <PainSection />
      <HowItWorksSection />
      <ProofSection />
      <FounderSection />
      <WaitlistSection />
      <FAQSection />
      <Footer />
    </main>
  );
}
```

- [ ] **Step 4: Verify**

Run from `frontend/`:

```powershell
npm run typecheck
npm run build
npm run dev
```

Expected:
- Typecheck passes.
- Build passes.
- `http://localhost:3000` shows all sections in correct order.

- [ ] **Checkpoint 1 Review Gate**

Show desktop and mobile screenshots of the static page.

Ask user to approve:
- Section order.
- Copy tone.
- Nav labels.
- Waitlist placement.

Stop for user approval.

---

## Checkpoint 2: Editorial Visual System Polish

**Purpose:** Make the static version feel premium before adding heavy motion.

**Files:**
- Modify: `frontend/app/globals.css`
- Modify: all `frontend/components/landing/*.tsx` section components from Checkpoint 1

- [ ] **Step 1: Apply typography hierarchy**

Rules:
- Spectral for display and founder/pain prose.
- Inter for body/UI.
- JetBrains Mono for section labels, proof stats, captions.
- No Inter display headlines.
- No centered hero.

- [ ] **Step 2: Apply Astrail colors**

Rules:
- Use `--void`, `--starlight`, `--muted`, `--faint`, `--brass`, `--line`.
- No pure black, pure white, purple, neon, or `#14193A`.
- Brass only for CTA, active lines, proof accent, and small labels.

- [ ] **Step 3: Make layout responsive**

Breakpoints:
- 375px: readable mobile, no horizontal scroll.
- 768px: tablet.
- 1024px: laptop.
- 1440px: desktop.

- [ ] **Step 4: Verify**

Run from `frontend/`:

```powershell
npm run typecheck
npm run build
```

Expected:
- Typecheck passes.
- Build passes.

- [ ] **Checkpoint 2 Review Gate**

Show screenshots:
- 1440px desktop.
- 390px mobile.

Ask user to approve:
- Typography.
- Spacing.
- Color balance.
- Whether it avoids generic AI slop.

Stop for user approval.

---

## Checkpoint 3: Hero Three.js Prototype Only

**Purpose:** Build the cinematic hero visual in isolation before connecting it to the full page.

**Files:**
- Create: `frontend/components/landing/GalaxyConstellation.tsx`
- Modify: `frontend/components/landing/HeroSection.tsx`

- [ ] **Step 1: Create client-only visual component**

Requirements:
- Start with 1,500 to 3,000 particles.
- Use `THREE.BufferGeometry` and `THREE.Points`.
- No individual mesh per particle.
- Add subtle blue/cyan only inside galaxy dust.
- Brass/starlight lines form one poetic constellation.
- Respect live `prefers-reduced-motion`.
- Clean up renderer, animation frame, event listeners, and geometry/materials.
- Mobile: fewer particles, no cursor interaction.

- [ ] **Step 2: Add static fallback**

Fallback states:
- Reduced motion: static star field and already-formed constellation.
- WebGL failure: CSS radial gradients and SVG constellation.

- [ ] **Step 3: Integrate into hero**

Hero remains left-aligned. Text and CTA stay readable above the visual.

- [ ] **Step 4: Verify**

Run from `frontend/`:

```powershell
npm run typecheck
npm run build
npm run dev
```

Manual checks:
- Load `/`.
- Observe auto-constellation sequence.
- Move cursor after sequence on desktop.
- Check mobile viewport has simplified scene.
- Enable reduced motion in browser/devtools if available and confirm static fallback.

- [ ] **Checkpoint 3 Review Gate**

Show:
- Desktop hero screenshot.
- Mobile hero screenshot.
- Short note on FPS/performance if measured.

Ask user to approve:
- Galaxy intensity.
- Constellation behavior.
- Hero readability.

Stop for user approval.

---

## Checkpoint 4: Pain And How-It-Works Motion

**Purpose:** Add the next narrative motions without turning the page into a generic animation showcase.

**Files:**
- Create: `frontend/components/landing/LightShards.tsx`
- Create: `frontend/components/landing/ScrollTrail.tsx`
- Modify: `frontend/components/landing/PainSection.tsx`
- Modify: `frontend/components/landing/HowItWorksSection.tsx`

- [ ] **Step 1: Implement soft light shards**

Rules:
- Vertical translucent shards imply saved Reels.
- No fake Instagram UI.
- No thumbnails, likes, usernames, or social chrome.
- Soft blur edges.
- Slow drift.
- Dissolve back into stars or fade at section end.
- Mobile simplified or static.

- [ ] **Step 2: Implement continuous constellation path**

Rules:
- One continuous route-like path through three steps.
- Avoid three equal feature cards.
- Use SVG path drawing or CSS stroke-dashoffset.
- Product-led step copy remains readable.

- [ ] **Step 3: Verify**

Run from `frontend/`:

```powershell
npm run typecheck
npm run build
```

Manual checks:
- Scroll from hero into pain section.
- Confirm "Inspiration is easy. Execution is broken." is readable.
- Confirm How It Works explains product clearly.
- Confirm no generic AI visuals or cards appear.

- [ ] **Checkpoint 4 Review Gate**

Show screenshots/video if available:
- Pain section.
- How It Works section.
- Mobile scroll state.

Ask user to approve:
- Soft shard style.
- How It Works clarity.
- Motion restraint.

Stop for user approval.

---

## Checkpoint 5: Proof, Founder, Waitlist, FAQ

**Purpose:** Finish conversion content after the main narrative is approved.

**Files:**
- Modify: `frontend/components/landing/ProofSection.tsx`
- Modify: `frontend/components/landing/FounderSection.tsx`
- Modify: `frontend/components/landing/WaitlistSection.tsx`
- Modify: `frontend/components/landing/FAQSection.tsx`
- Modify or copy: `frontend/public/SeaXOpenAI.jpg`

- [ ] **Step 1: Build Proof section**

Content:
- YouTube source: `https://www.youtube.com/watch?v=EoAxPk6OCdo`
- Embed URL: `https://www.youtube.com/embed/EoAxPk6OCdo`
- Award photo: existing `frontend/public/SeaXOpenAI.jpg`

Rules:
- Demo theater is primary.
- Award photo is restrained receipt.
- Caption: "Zhi Hao and Shaun at the SEA x OpenAI Regional Codex Hackathon, Singapore, June 2026."
- Copy frames demo honestly as raw hackathon proof and beta rebuild.

- [ ] **Step 2: Build Founder section**

Use both-builder voice:

```text
We built Astrail because we kept saving places we wanted to visit, then watching those saves become nothing.

The inspiration was there. The execution layer was missing.

Astrail is our attempt to turn that gap into a product: from scattered Reels, to verified places, to a route you can actually follow.
```

- [ ] **Step 3: Build Waitlist section**

Rules:
- Inline Tally embed:
  `https://tally.so/embed/QKjrvk?hideTitle=1&transparentBackground=1&dynamicHeight=1`
- Fallback link:
  `https://tally.so/r/QKjrvk`
- Email only.
- Quiet founder invitation.
- No countdown.
- No fake scarcity.

- [ ] **Step 4: Build FAQ**

Use the four FAQ entries from `landing-copy.ts`.

- [ ] **Step 5: Verify**

Run from `frontend/`:

```powershell
npm run typecheck
npm run build
```

Manual checks:
- YouTube embed loads.
- Award image is not oversized.
- Tally embed loads.
- Fallback link is visible.
- FAQ is readable on mobile.

- [ ] **Checkpoint 5 Review Gate**

Show:
- Proof section.
- Founder section.
- Waitlist section with Tally.
- FAQ section.

Ask user to approve:
- Proof balance.
- Founder tone.
- Waitlist copy.
- FAQ wording.

Stop for user approval.

---

## Checkpoint 6: Mobile, Performance, Accessibility, And Deployment Readiness

**Purpose:** Make the page production-safe for `astrail.xyz`.

**Files:**
- Modify as needed: landing components and styles.
- Modify as needed: `frontend/package.json`
- Modify as needed: `docker-compose.yml`

- [ ] **Step 1: Mobile QA**

Check:
- 375px width.
- 390px width.
- 768px width.
- No text overlap.
- CTA reachable.
- Tally form usable.
- No horizontal scroll.
- Three.js simplified.

- [ ] **Step 2: Accessibility QA**

Check:
- Keyboard focus visible.
- Nav anchors work.
- CTA focus states work.
- Iframe has accessible title.
- Images have alt text.
- Reduced motion fallback works.
- Contrast is readable.

- [ ] **Step 3: Performance QA**

Check:
- No excessive particle count.
- No animation on layout properties.
- Three.js disposes resources.
- Page content renders even if visual fails.
- Mobile does not run desktop particle count.

- [ ] **Step 4: Build verification**

Run from `frontend/`:

```powershell
npm run typecheck
npm run build
```

Expected:
- Both pass.

- [ ] **Step 5: Docker verification**

Run from repo root:

```powershell
docker compose config
docker compose up --build
```

Expected:
- Compose config is valid.
- Frontend serves on `http://localhost:3000`.

- [ ] **Step 6: Vercel readiness checklist**

Confirm:
- Vercel project root points to `frontend/`.
- Build command: `npm run build`.
- Install command: `npm install`.
- Output framework: Next.js.
- Production branch: `main`.
- Domain: `astrail.xyz`.

- [ ] **Checkpoint 6 Review Gate**

Show:
- Final desktop screenshot.
- Final mobile screenshot.
- Build output.
- Docker output.
- Vercel setup notes.

Stop for user approval before any commit/push/deploy action.

---

## Self-Review

### Spec Coverage

- Waitlist conversion: covered by Checkpoints 1 and 5.
- X traffic wow moment: covered by Checkpoint 3.
- Premium cinematic style: covered by Checkpoints 2, 3, and 4.
- No generic AI slop: covered in design rules and review gates.
- Soft light shards: covered by Checkpoint 4.
- How It Works continuous path: covered by Checkpoint 4.
- Hackathon proof and award photo: covered by Checkpoint 5.
- Both-builder founder story: covered by Checkpoint 5.
- Tally/Beehiiv/Zapier path: covered by Checkpoint 5 with Tally embed.
- Mobile UX: covered by Checkpoints 3, 4, and 6.
- Three.js exception: isolated to Checkpoint 3 visual component.
- Docker local dev: covered by Checkpoints 0 and 6.
- Vercel readiness: covered by Checkpoint 6.

### Placeholder Scan

No task depends on "TBD", "TODO", or unspecified implementation. Each checkpoint has exact files, commands, review output, and approval gate.

### Type Consistency

All landing copy imports come from `frontend/components/landing/landing-copy.ts`. `tallyEmbedUrl`, `tallyFallbackUrl`, `howItWorksSteps`, `faqs`, and `navItems` are named consistently in the plan.
