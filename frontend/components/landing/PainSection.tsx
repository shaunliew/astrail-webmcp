import LightShards from "./LightShards";

export default function PainSection() {
  return (
    <section className="relative overflow-hidden px-5 py-24 md:px-10">
      <LightShards className="pain-local-shards" />
      <div className="section-frame relative z-10 mx-auto grid max-w-7xl gap-12 pt-16 lg:grid-cols-[0.8fr_1fr]">
        <div>
          <p className="type-label mb-5 text-xs uppercase tracking-[0.18em] text-[color:var(--brass)]">
            The problem
          </p>
          <h2 className="type-display max-w-2xl text-5xl font-normal leading-[0.96] md:text-7xl">
            Inspiration is easy. Execution is broken.
          </h2>
        </div>
        <div className="hero-copy-shadow lg:pt-2">
          <p className="max-w-2xl text-lg leading-8 text-[color:var(--muted)]">
            You save the noodle shop, the viewpoint, the tiny cafe, the one
            temple everyone says is worth it. Then the folder grows, the trip
            gets closer, and nothing connects.
          </p>
          <div className="mt-10 grid gap-3">
            {["Saved", "Unsorted", "Unplanned"].map((label) => (
              <div
                className="saved-fragment flex min-h-14 items-center justify-between px-5 py-4"
                key={label}
              >
                <p className="type-label text-xs uppercase tracking-[0.14em] text-[color:var(--faint)]">
                  {label}
                </p>
                <span className="h-px w-16 bg-[color:var(--line)]" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
