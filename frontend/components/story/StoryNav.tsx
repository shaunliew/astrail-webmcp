'use client'

import Link from 'next/link'

import { AstrailLogo } from '@/components/brand/AstrailLogo'
import { SEATS_TOTAL } from './story-config'

/* Persistent chrome, repointed to the open beta (2026-08-03). Glass pills so
   the same nav reads on both the warm ivory hero and the night sections. The
   primary action is now the product itself — sign up and plan — not a waitlist.
   Scarcity is real (25 unlimited seats) but earned by activation, so signing up
   IS how you get considered; there is no separate "request a seat" button to
   go dead before the entitlement backend ships. */
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
          <b>{SEATS_TOTAL} seats</b> &middot; open beta
        </span>
        <Link href="/sign-in" className="story-nav__link">
          Log in
        </Link>
        <Link href="/sign-in" className="story-nav__cta">
          Start planning free
        </Link>
      </div>
    </nav>
  )
}
