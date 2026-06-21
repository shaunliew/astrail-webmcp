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
              We built Astrail because we kept saving places we wanted to visit,
              then watching those saves become nothing.
            </p>
            <p className="text-[color:var(--muted)]">
              The inspiration was there. The execution layer was missing.
            </p>
            <p className="text-[color:var(--muted)]">
              Astrail is our attempt to turn that gap into a product: from
              scattered Reels, to verified places, to a route you can actually
              follow.
            </p>
          </div>
          <p className="type-label mt-8 text-xs uppercase tracking-[0.16em] text-[color:var(--faint)]">
            Zhi Hao and Shaun / Singapore / 2026
          </p>
        </div>
        <div className="surface self-end p-5">
          <p className="type-label text-xs uppercase tracking-[0.16em] text-[color:var(--brass)]">
            What we are building toward
          </p>
          <ul className="mt-6 space-y-5 text-sm leading-6 text-[color:var(--muted)]">
            <li>Verified places from messy travel saves.</li>
            <li>Route logic you can inspect before trusting.</li>
            <li>A planner that learns your pace, budget, and preferences.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
