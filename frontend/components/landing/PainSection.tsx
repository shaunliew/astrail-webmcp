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
            Saving places is easy. Planning around them isn&apos;t.
          </h2>
        </div>
        <div className="hero-copy-shadow lg:pt-2">
          <p className="max-w-2xl text-lg leading-8 text-[rgba(242,236,224,0.72)]">
            You saved the ramen spot, a viewpoint, that one cafe, the temple
            your friend keep talking about. Two weeks before the trip you
            open the folder and realize none of it adds up to a route.
          </p>
          <div className="mt-10 grid gap-3">
            {["Saved", "Unsorted", "Unplanned"].map((label) => (
              <div
                className="saved-fragment flex min-h-14 items-center justify-between px-5 py-4"
                key={label}
              >
                <p className="type-label text-xs uppercase tracking-[0.14em] text-[rgba(242,236,224,0.58)]">
                  {label}
                </p>
                <span className="h-px w-16 bg-[rgba(242,236,224,0.2)]" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
