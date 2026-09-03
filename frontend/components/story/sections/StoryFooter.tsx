import Link from 'next/link'

import { AstrailLogo } from '@/components/brand/AstrailLogo'
import { contactEmail } from '@/components/landing/landing-copy'

/* The full footer — the trust + legal spine a live product needs (a waitlist
   page can skip it; a beta taking real accounts can't). Dark so the chrome
   wordmark reads. Privacy/Terms point at real pages (beta drafts pending
   review); contact + feedback route to the inbound alias. */
type FooterLink = { label: string; href: string; external?: boolean }

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'How it works', href: '#how-it-works' },
      { label: 'FAQ', href: '#faq' },
      { label: 'Sign in', href: '/sign-in' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'Contact', href: `mailto:${contactEmail}`, external: true },
      {
        label: 'Send feedback',
        href: `mailto:${contactEmail}?subject=Astrail%20beta%20feedback`,
        external: true,
      },
      { label: 'Instagram', href: 'https://www.instagram.com/astrail.xyz/', external: true },
      { label: 'X', href: 'https://x.com/astrailxyz', external: true },
      { label: '@haotobuildzip', href: 'https://x.com/haotobuildzip', external: true },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
    ],
  },
]

function FooterItem({ link }: { link: FooterLink }) {
  const cls =
    'text-sm text-[color:var(--starlight-70)] transition hover:text-[color:var(--starlight)]'
  if (link.external) {
    return (
      <a
        href={link.href}
        target={link.href.startsWith('mailto:') ? undefined : '_blank'}
        rel="noreferrer"
        className={cls}
      >
        {link.label}
      </a>
    )
  }
  if (link.href.startsWith('#')) {
    return (
      <a href={link.href} className={cls}>
        {link.label}
      </a>
    )
  }
  return (
    <Link href={link.href} className={cls}>
      {link.label}
    </Link>
  )
}

export default function StoryFooter() {
  return (
    <footer className="bg-[color:var(--night-900)] px-6 py-16 md:px-12">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="col-span-2 md:col-span-1">
          <AstrailLogo variant="lockup" tone="chrome" height={26} />
          <p className="mt-4 max-w-[30ch] text-sm leading-relaxed text-[color:var(--starlight-70)]">
            Turn the travel reels you saved into a route you&rsquo;ll actually
            take. Evidence-backed planning on a real map.
          </p>
          <p className="mt-4 text-xs uppercase tracking-[0.16em] text-[color:var(--starlight-70)]">
            WebMCP Challenge build
          </p>
        </div>

        {COLUMNS.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--starlight)]">
              {col.title}
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {col.links.map((link) => (
                <li key={link.label}>
                  <FooterItem link={link} />
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="mx-auto mt-14 flex max-w-6xl flex-col gap-2 border-t border-[color:var(--night-line)] pt-6 text-xs text-[color:var(--starlight-70)] md:flex-row md:items-center md:justify-between">
        <p>&copy; 2026 Astrail &middot; Singapore &middot; WebMCP Challenge build</p>
        <p>
          Astrail is a WebMCP Challenge build, not a finished product. It uses AI to
          generate recommendations from public content, so double-check details
          before you travel.
        </p>
      </div>
    </footer>
  )
}
