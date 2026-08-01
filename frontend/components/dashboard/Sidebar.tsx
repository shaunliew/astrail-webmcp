'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { createClient } from '@/lib/supabase/client'

/* Persistent paper sidebar for the /app document routes (dashboard, trails, settings).
   Connected full-bleed rail (see (shell)/layout.tsx): an identity block up top, icon-led
   nav, and a bottom account section (Settings + Log out) over a divider. Desktop = a
   vertical rail; mobile = a horizontal top bar with icon-only rows. Palette role tokens
   keep the parent .app-shell scope from bleeding in; the brand is the brass trail
   primitive, not the white logo PNG (which is for the dark map screens). */

type IconProps = { className?: string }

const NAV: { href: string; label: string; Icon: ComponentType<IconProps> }[] = [
  { href: '/app', label: 'Home', Icon: HomeIcon },
  { href: '/app/trips', label: 'Trails', Icon: RouteIcon },
]

function isActive(pathname: string, href: string): boolean {
  return href === '/app' ? pathname === '/app' : pathname.startsWith(href)
}

const rowClass = (active: boolean) =>
  `group flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-[14px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] ${
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

  async function signOut() {
    await createClient().auth.signOut()
    router.push('/sign-in')
  }

  const settingsActive = isActive(pathname, '/app/settings')

  return (
    <aside className="relative z-10 flex flex-row items-center justify-between gap-2 border-b border-[color:var(--line-soft)] bg-[color:var(--surface-1)] p-3 sm:h-full sm:w-[212px] sm:flex-col sm:items-stretch sm:justify-start sm:gap-0 sm:border-b-0 sm:border-r">
      {/* Identity — the brand mark + signed-in account. Static header, not a switcher. */}
      <div className="flex items-center gap-2.5 rounded-lg p-1 sm:mb-1">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[8px] border border-[color:var(--line-soft)] bg-[color:var(--surface-2)]">
          <MiniMark />
        </span>
        <span className="flex min-w-0 flex-col">
          <span
            className="font-display text-[14px] font-semibold leading-tight text-[color:var(--text)]"
            style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 0, 'opsz' 15" }}
          >
            Astrail
          </span>
          <span className="hidden truncate text-[11px] leading-tight text-[color:var(--text-muted)] sm:block">
            {email ?? 'Account'}
          </span>
        </span>
      </div>

      {/* Main nav */}
      <nav aria-label="Main" className="flex flex-row gap-1 sm:mt-5 sm:flex-col">
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

      <div className="hidden sm:block sm:flex-1" />

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

/* ---- Icons: inline SVG, currentColor stroke so they inherit the row's text colour.
   The mark stays brass in every state — it's the brand, not UI chrome. ---- */

function MiniMark() {
  return (
    <svg viewBox="0 0 24 22" aria-hidden className="h-[18px] w-[18px]">
      <polyline
        points="3,16 9,8 15,12 21,4"
        fill="none"
        stroke="var(--brass-deep)"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="3" cy="16" r="2" fill="var(--brass-deep)" />
      <circle cx="9" cy="8" r="2" fill="var(--brass-deep)" />
      <circle cx="15" cy="12" r="2" fill="var(--brass-deep)" />
      <circle cx="21" cy="4" r="2.3" fill="none" stroke="var(--brass-deep)" strokeWidth="1.2" strokeDasharray="2 2" />
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
