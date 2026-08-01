'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AstrailLogo } from '@/components/brand/AstrailLogo'
import { listTrips } from '@/lib/trip/supabase-api'
import type { Trip } from '@/lib/trip/backend-types'

/* Persistent paper sidebar for the /app document routes (dashboard, trails, settings).
   Connected full-bleed rail (see (shell)/layout.tsx): an identity block up top, a primary
   "New trail" action, icon-led nav, a live Recent-trails list that fills the rail, and a
   bottom account section (Settings + Log out) over a divider. Desktop = a vertical rail;
   mobile = a horizontal top bar with icon-only rows (the CTA + recents are desktop-only so
   the top bar stays lean). Palette role tokens keep the parent .app-shell scope from
   bleeding in; the brand is the A-swoosh-star mark recoloured brass (AstrailLogo
   tone="brass") so it reads on the cream paper. */

type IconProps = { className?: string }

const NAV: { href: string; label: string; Icon: ComponentType<IconProps> }[] = [
  { href: '/app', label: 'Home', Icon: HomeIcon },
  { href: '/app/trips', label: 'Trails', Icon: RouteIcon },
]

const RECENTS_LIMIT = 8

function isActive(pathname: string, href: string): boolean {
  return href === '/app' ? pathname === '/app' : pathname.startsWith(href)
}

// Best available human label for a trip row — narrator title first, then whatever
// destination we inferred/were told, then a neutral fallback so a row never renders blank.
function tripLabel(trip: Trip): string {
  return trip.title || trip.inferred_destination || trip.destination_hint || 'Untitled trail'
}

const rowClass = (active: boolean) =>
  `group flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-[14px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] ${
    active
      ? 'bg-[color:var(--surface-2)] font-medium text-[color:var(--text)]'
      : 'text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] hover:text-[color:var(--text)]'
  }`

const recentRowClass = (active: boolean) =>
  `flex min-h-8 items-center rounded-md px-2.5 text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] ${
    active
      ? 'bg-[color:var(--surface-2)] font-medium text-[color:var(--text)]'
      : 'text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] hover:text-[color:var(--text)]'
  }`

const iconClass = (active: boolean) =>
  `h-4 w-4 shrink-0 ${
    active
      ? 'text-[color:var(--text)]'
      : 'text-[color:var(--text-muted)] group-hover:text-[color:var(--text)]'
  }`

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [recents, setRecents] = useState<Trip[]>([])

  useEffect(() => {
    let active = true
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (active) setEmail(data.user?.email ?? null)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  // Recent trails fill the rail (Claude's "Recents" move). Non-critical: on any failure we
  // simply render no list — the rail falls back to empty flex space, never an error.
  useEffect(() => {
    let active = true
    listTrips()
      .then((trips) => {
        if (active) setRecents(trips.slice(0, RECENTS_LIMIT))
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  async function signOut() {
    await createClient().auth.signOut()
    router.push('/sign-in')
  }

  const settingsActive = isActive(pathname, '/app/settings')

  return (
    <aside className="relative z-10 flex flex-row items-center justify-between gap-2 border-b border-[color:var(--line-soft)] bg-[color:var(--surface-1)] p-3 sm:h-full sm:w-[256px] sm:flex-col sm:items-stretch sm:justify-start sm:gap-0 sm:border-b-0 sm:border-r">
      {/* Identity — the brand mark + signed-in account. Static header, not a switcher. */}
      <div className="flex items-center gap-2.5 rounded-lg p-1 sm:mb-1">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[8px] border border-[color:var(--line-soft)] bg-[color:var(--surface-2)]">
          <AstrailLogo variant="mark" tone="brass" height={20} />
        </span>
        <span className="hidden min-w-0 truncate text-[11px] leading-tight text-[color:var(--text-muted)] sm:block">
          {email ?? 'Account'}
        </span>
      </div>

      {/* Primary action — start a new trail. Desktop-only so the mobile top bar stays lean. */}
      <Link
        href="/app"
        className="hidden items-center justify-center gap-2 rounded-lg border border-[color:var(--accent)] bg-[color:var(--accent)] px-3 py-2.5 text-[13px] font-medium text-[color:var(--accent-text)] transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] sm:mt-4 sm:flex"
      >
        <PlusIcon className="h-4 w-4" />
        New trail
      </Link>

      {/* Main nav */}
      <nav aria-label="Main" className="flex flex-row gap-1 sm:mt-4 sm:flex-col">
        {NAV.map(({ href, label, Icon }) => {
          const active = isActive(pathname, href)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={rowClass(active)}
            >
              <Icon className={iconClass(active)} />
              <span className="hidden truncate sm:inline">{label}</span>
            </Link>
          )
        })}
      </nav>

      {/* Recent trails — fills the rail. Desktop-only; grows to take the free space and
          scrolls past the limit. When empty it's just flex space, pushing account to the
          floor exactly as the old spacer did. */}
      <div className="hidden min-h-0 flex-1 flex-col sm:mt-6 sm:flex">
        {recents.length > 0 ? (
          <>
            <p className="px-2.5 pb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-[color:var(--text-faint)]">
              Recent
            </p>
            <nav aria-label="Recent trails" className="min-h-0 flex-1 overflow-y-auto">
              <ul className="flex flex-col gap-0.5">
                {recents.map((trip) => {
                  const active = pathname === `/app/trip/${trip.id}`
                  return (
                    <li key={trip.id}>
                      <Link
                        href={`/app/trip/${trip.id}`}
                        aria-current={active ? 'page' : undefined}
                        className={recentRowClass(active)}
                      >
                        <span className="truncate">{tripLabel(trip)}</span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </nav>
          </>
        ) : null}
      </div>

      {/* Account section */}
      <div className="flex flex-row gap-1 sm:flex-col sm:border-t sm:border-[color:var(--line-soft)] sm:pt-3">
        <Link
          href="/app/settings"
          aria-current={settingsActive ? 'page' : undefined}
          className={rowClass(settingsActive)}
        >
          <SettingsIcon className={iconClass(settingsActive)} />
          <span className="hidden truncate sm:inline">Settings</span>
        </Link>
        <button type="button" onClick={() => void signOut()} className={rowClass(false)}>
          <LogOutIcon className={iconClass(false)} />
          <span className="hidden truncate sm:inline">Log out</span>
        </button>
      </div>
    </aside>
  )
}

/* ---- Icons: inline SVG, currentColor stroke so they inherit the row's text colour. ---- */

function PlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function HomeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d="M3.5 10.5 12 3.5l8.5 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 9.5V20h4.5v-5.5h4V20h4.5V9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RouteIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d="M6.8 18C11 18 13 6 17.2 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="5" cy="18.5" r="2.1" fill="currentColor" />
      <circle cx="19" cy="5.5" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function SettingsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function LogOutIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d="M9.5 4.5H6.5A2 2 0 0 0 4.5 6.5v11a2 2 0 0 0 2 2h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 12h7M17.5 8.5l3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
