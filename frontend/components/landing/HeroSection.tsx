import GalaxyConstellation from "./GalaxyConstellation";

export default function HeroSection() {
  return (
    <section
      className="relative flex min-h-[100dvh] items-center overflow-hidden px-5 pb-20 pt-24 md:px-10 md:pb-24 md:pt-28"
      id="top"
    >
      <GalaxyConstellation />
      <div className="relative z-10 mx-auto w-full max-w-7xl">
        <div className="hero-copy-shadow max-w-[760px]">
          <p className="type-label mb-6 text-xs uppercase tracking-[0.18em] text-[color:var(--brass)]">
            Beta · Singapore
          </p>
          <h1 className="type-display max-w-3xl text-5xl font-normal leading-[0.94] text-[color:var(--starlight)] md:text-8xl md:leading-[0.92]">
            You saved 60 travel Reels. Now what?
          </h1>
          <p className="type-body mt-7 max-w-xl text-lg font-light leading-8 text-[color:var(--muted)]">
            Paste the links. Astrail pulls out the actual places, checks they
            exist, and builds a day-by-day plan that explains why each stop is
            on it.
          </p>
          <div className="mt-9 flex flex-wrap gap-4">
            <a
              className="type-label inline-flex min-h-12 items-center border border-[color:var(--brass)] bg-[rgba(201,151,78,0.18)] px-5 text-xs uppercase tracking-[0.14em] text-[color:var(--starlight)] backdrop-blur transition hover:bg-[color:var(--brass)]/20"
              href="#waitlist"
            >
              Join waitlist
            </a>
            <a
              className="type-label inline-flex min-h-12 items-center border border-[color:var(--line)] bg-[rgba(5,5,6,0.3)] px-5 text-xs uppercase tracking-[0.14em] text-[color:var(--muted)] backdrop-blur transition hover:text-[color:var(--starlight)]"
              href="#how-it-works"
            >
              See how it works
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
