'use client'

import Link from 'next/link'

import { AstrailLogo } from '@/components/brand/AstrailLogo'

/* Persistent chrome. Glass pills so the same nav reads on both the warm ivory hero and the night
   sections.

   The seat counter ("25 seats · open beta") is gone on THIS deployment. It is a real scarcity
   signal for the product, and reading it on a challenge build invites exactly the wrong
   conclusion: that a judge is being funnelled toward a beta rather than shown an experiment. The
   sign-in stays, because judges have credentials and need somewhere to use them — it just no
   longer sells anything. */
export default function StoryNav() {
  return (
    <nav className="story-nav" aria-label="Astrail">
      <div className="story-nav__pill">
        <Link href="/" aria-label="Astrail home" className="flex items-center">
          <AstrailLogo variant="lockup" tone="chrome" height={22} priority />
        </Link>
        <a href="#story" className="story-nav__link">
          Story
        </a>
        <a href="#how-it-works" className="story-nav__link">
          How it works
        </a>
        <a href="#faq" className="story-nav__link">
          FAQ
        </a>
      </div>

      <div className="story-nav__pill">
        <span className="story-nav__seats">
          <b>WebMCP</b> &middot; challenge build
        </span>
        <Link href="/sign-in" className="story-nav__cta">
          Sign in to try it
        </Link>
      </div>
    </nav>
  )
}
