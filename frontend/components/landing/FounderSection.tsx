export default function FounderSection() {
  return (
    <section className="px-5 py-24 md:px-10">
      <div className="section-frame mx-auto grid max-w-7xl gap-10 pt-16 lg:grid-cols-[0.72fr_0.28fr]">
        <div className="border-l border-[color:var(--brass)] pl-6 md:pl-10">
          <p className="type-label mb-6 text-xs uppercase tracking-[0.18em] text-[color:var(--brass)]">
            From the builders
          </p>
          <div className="type-display max-w-4xl space-y-6 text-3xl leading-tight text-[color:var(--starlight)] md:text-5xl">
            <p>
              We built Astrail because we both had the same problem: hundreds of
              saved Reels, zero actual trips planned from them. The intent was
              there. The tool to turn it into a route wasn&apos;t.
            </p>
            <p className="text-[color:var(--muted)]">
              So we built one. First as a hackathon prototype, now as something
              we&apos;d actually trust on our own trips.
            </p>
            <p className="text-[color:var(--muted)]">
              Zhi Hao and Shaun · Singapore · 2026
            </p>
          </div>
        </div>
        <div className="surface self-end p-5">
          <p className="type-label text-xs uppercase tracking-[0.16em] text-[color:var(--brass)]">
            What we are building toward
          </p>
          <ul className="mt-6 space-y-5 text-sm leading-6 text-[color:var(--muted)]">
            <li>Verified places, not guesses.</li>
            <li>Route logic you can inspect before you trust it.</li>
            <li>A planner that learns your pace, budget, and habits over time.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
