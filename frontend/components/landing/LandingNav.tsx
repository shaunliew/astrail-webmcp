import Image from "next/image";

import { navItems } from "./landing-copy";

export default function LandingNav() {
  return (
    <header className="fixed left-0 right-0 top-0 z-20 border-b border-[color:var(--line)] bg-[rgba(5,5,6,0.86)] px-5 py-4 backdrop-blur-md md:px-10">
      <nav className="mx-auto flex max-w-7xl items-center justify-between gap-6">
        <a
          href="#top"
          className="flex items-center"
          aria-label="Astrail home"
        >
          <Image
            src="/astrail_logo.png"
            alt="Astrail"
            width={100}
            height={100}
            priority
            className="h-15 w-15 object-contain"
          />
        </a>
        <div className="type-label flex items-center gap-5 text-xs uppercase tracking-[0.16em] text-[color:var(--muted)]">
          {navItems.map((item) => (
            <a
              className="hidden transition hover:text-[color:var(--starlight)] sm:inline"
              href={item.href}
              key={item.href}
            >
              {item.label}
            </a>
          ))}
          <a
            className="border border-[color:var(--brass)]/70 px-3 py-2 text-[color:var(--starlight)] transition hover:bg-[color:var(--brass-soft)]"
            href="#waitlist"
          >
            Join waitlist
          </a>
        </div>
      </nav>
    </header>
  );
}
