import type { Metadata } from "next";
import Script from "next/script";
import { Fraunces, Figtree, IBM_Plex_Mono } from "next/font/google";
import { SITE_ORIGIN } from "@/lib/site";
import "./globals.css";
// Locked paper design system (2026-07-26). Imported AFTER globals so its :root tokens
// win over the retired Night & Daybreak values by source order — palette.css is
// authoritative. Un-ported app screens stay readable via the structural night tokens
// kept in globals.css; the marketing landing is pinned under `.landing`.
import "./palette.css";
import "./type.css";

// Locked type system (DESIGN.md §3, 2026-07-26):
//   Display   Fraunces      variable serif — opsz + SOFT + WONK axes, ital for the source quote
//   UI        Figtree       variable warm geometric sans
//   Evidence  IBM Plex Mono provenance only (not variable — explicit weights)
// Inter is deliberately absent: the type carries the brand, so it can't be the AI-slop default.
const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
});

const figtree = Figtree({
  subsets: ["latin"],
  variable: "--font-figtree",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-ibm-plex-mono",
});

export const metadata: Metadata = {
  metadataBase: SITE_ORIGIN,
  title: "Astrail · Plan trips from your saved travel Reels",
  description:
    "Paste your saved travel Reels. Astrail extracts the places, verifies them, and builds a day-by-day itinerary with the reasoning attached. Beta opening soon.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      // globals.css sets scroll-behavior: smooth; this attribute tells Next to
      // keep disabling it during route transitions once the auto-detect is
      // removed (nextjs.org/docs/messages/missing-data-scroll-behavior).
      data-scroll-behavior="smooth"
      className={`${fraunces.variable} ${figtree.variable} ${ibmPlexMono.variable}`}
    >
      <body>
        {children}
        {/* Tally popup loader — powers the in-app Feedback button (PdNreP) and the
            landing "Notify me" popup (QKjrvk). CSP already allows tally.so (script/frame). */}
        <Script src="https://tally.so/widgets/embed.js" strategy="lazyOnload" />
      </body>
    </html>
  );
}
