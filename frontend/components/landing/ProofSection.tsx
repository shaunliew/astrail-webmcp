import Image from "next/image";
import DemoVideoEmbed from "./DemoVideoEmbed";

export default function ProofSection() {
  return (
    <section className="px-5 py-24 md:px-10" id="proof">
      <div className="section-frame mx-auto grid max-w-7xl gap-10 pt-16 lg:grid-cols-[1fr_0.52fr]">
        <div>
          <p className="type-label mb-5 text-xs uppercase tracking-[0.18em] text-[color:var(--brass)]">
            Proof
          </p>
          <div className="mb-8 max-w-3xl">
            <h2 className="type-display text-5xl font-normal leading-[0.96] md:text-7xl">
              First proven under pressure. Now rebuilt for real trips.
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[color:var(--muted)]">
              The hackathon demo showed the core loop: scattered travel intent
              can become a researched route. The beta is the slower, more
              reliable version of that idea.
            </p>
          </div>
          <div className="surface relative aspect-video overflow-hidden">
            <DemoVideoEmbed />
          </div>
          <p className="type-label mt-4 text-xs uppercase tracking-[0.14em] text-[color:var(--faint)]">
            Raw hackathon demo. The beta is being rebuilt for reliability.{" "}
            <a
              className="text-[color:var(--brass)]"
              href="https://www.youtube.com/watch?v=EoAxPk6OCdo"
              rel="noreferrer"
              target="_blank"
            >
              Watch on YouTube
            </a>
            .
          </p>
        </div>
        <aside className="self-end">
          <div className="surface overflow-hidden">
            <div className="relative aspect-[4/5]">
              <Image
                alt="Zhi Hao and Shaun at the SEA x OpenAI Regional Codex Hackathon, Singapore, June 2026."
                className="object-cover"
                fill
                priority={false}
                sizes="(min-width: 1024px) 34vw, 100vw"
                src="/SeaXOpenAI.jpg"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,5,6,0.04),rgba(5,5,6,0.42))]" />
            </div>
            <div className="border-t border-[color:var(--line)] p-5">
              <p className="type-label text-xs uppercase tracking-[0.16em] text-[color:var(--brass)]">
                Second place / USD 15,000 OpenAI API credits
              </p>
              <p className="mt-4 leading-7 text-[color:var(--muted)]">
                Zhi Hao and Shaun at the SEA x OpenAI Regional Codex Hackathon,
                Singapore, June 2026.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
