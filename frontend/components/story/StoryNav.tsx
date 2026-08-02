'use client'

import Link from 'next/link'

import { AstrailLogo } from '@/components/brand/AstrailLogo'
import { tallyFallbackUrl } from '@/components/landing/landing-copy'
import { BOARDING_OPEN, SEATS_TOTAL } from './story-config'

/* Persistent chrome. Glass pills so the same nav reads on both the warm ivory
   acts and the night acts without theme switching. Seat truth: no invented
   counts — waitlist is primary until boarding actually opens. */
export default function StoryNav() {
  return (
    <nav className="story-nav" aria-label="Astrail">
      <Link href="/" className="story-nav__pill" aria-label="Astrail home">
        <AstrailLogo variant="lockup" tone="chrome" height={24} priority />
      </Link>
      <div className="story-nav__pill">
        <span className="story-nav__seats">
          <b>{SEATS_TOTAL} seats</b> &middot; boarding soon
        </span>
        {BOARDING_OPEN ? (
          <Link href="/sign-in" className="story-nav__cta">
            Claim a seat
          </Link>
        ) : (
          <a
            href={tallyFallbackUrl}
            target="_blank"
            rel="noreferrer"
            className="story-nav__cta"
          >
            Join the waitlist
          </a>
        )}
      </div>
    </nav>
  )
}
