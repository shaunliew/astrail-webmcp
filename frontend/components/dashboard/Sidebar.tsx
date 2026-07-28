'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { BrandMark } from '@/components/door/DoorChrome'

/* Persistent paper sidebar for the /app document routes (dashboard, trails, settings).
   The brand is the brass trail-primitive (not the white logo PNG, which is for the dark
   map screens). Uses palette role tokens so the parent .app-shell scope doesn't bleed in.
   Full-height rail on desktop; a horizontal top bar on mobile. */

const NAV = [
  { href: '/app', label: 'Home' },
  { href: '/app/trips', label: 'Trails' },
  { href: '/app/settings', label: 'Settings' },
]

function isActive(pathname: string, href: string): boolean {
  return href === '/app' ? pathname === '/app' : pathname.startsWith(href)
}

export default function Sidebar() {
  const pathname = usePathname()
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

  return (
    <aside className="flex flex-none items-center justify-between gap-4 rounded-2xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] p-4 md:h-full md:w-[212px] md:flex-col md:items-stretch md:justify-start">
      <div className="flex h-8 items-center gap-2">
        <BrandMark />
        <span
          className="font-display text-[15px] font-semibold tracking-[0.01em] text-[color:var(--text)]"
          style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 0, 'opsz' 15" }}
        >
          Astrail
        </span>
      </div>

      <nav aria-label="Main" className="flex flex-row gap-1 md:mt-6 md:flex-col">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`flex min-h-11 items-center rounded-lg px-3 text-[14px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] ${
                active
                  ? 'bg-[color:var(--surface-2)] font-semibold text-[color:var(--text)]'
                  : 'text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] hover:text-[color:var(--text)]'
              }`}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="hidden md:block md:flex-1" />

      <div className="hidden min-h-11 items-center gap-3 border-t border-[color:var(--line-soft)] pt-4 md:flex">
        <span aria-hidden className="h-8 w-8 flex-none rounded-full border border-[color:var(--paper-line-2)] bg-[color:var(--surface-2)]" />
        <span className="min-w-0 truncate text-[13px] text-[color:var(--text-muted)]">{email ?? 'Account'}</span>
      </div>
    </aside>
  )
}
