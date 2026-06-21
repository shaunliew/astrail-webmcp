import ScrollTrail from "./ScrollTrail";
import { howItWorksSteps } from "./landing-copy";

export default function HowItWorksSection() {
  return (
    <section
      className="relative overflow-hidden px-5 py-24 md:px-10"
      id="how-it-works"
    >
      <div className="section-frame relative mx-auto max-w-7xl pt-16">
        <ScrollTrail className="how-section-route" />
        <div className="relative z-10">
          <p className="type-label mb-5 text-xs uppercase tracking-[0.18em] text-[color:var(--brass)]">
            How it works
          </p>
          <h2 className="type-display max-w-4xl text-5xl font-normal leading-[0.96] md:text-7xl">
            Stars become signals. Signals become stops. Stops become a trail.
          </h2>
          <div className="relative mt-14 grid gap-8 lg:grid-cols-3">
            <div className="absolute left-0 right-0 top-0 hidden h-px bg-[color:var(--line)] lg:block" />
            {howItWorksSteps.map((step, index) => (
              <article
                className="relative border-t border-[color:var(--line)] pt-6 lg:border-t-0"
                key={step.title}
              >
                <span className="absolute -top-[3px] left-0 hidden h-[5px] w-[5px] bg-[color:var(--brass)] lg:block" />
                <p className="type-label text-xs uppercase tracking-[0.16em] text-[color:var(--brass)]">
                  N {String(index + 1).padStart(2, "0")}
                </p>
                <h3 className="type-display mt-5 text-3xl font-normal leading-tight text-[color:var(--starlight)]">
                  {step.title}
                </h3>
                <p className="mt-4 leading-7 text-[color:var(--muted)]">
                  {step.body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
