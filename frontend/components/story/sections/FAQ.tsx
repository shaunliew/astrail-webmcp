import { faqs } from '@/components/landing/landing-copy'

/* Objection handling. Static (not an accordion) — six short Q/As read faster
   than they click. Copy lives in landing-copy so edits stay in one file.
   Retargeted for the challenge build: the questions are about what was made and
   whether it can be trusted, not about joining a beta. */
export default function FAQ() {
  return (
    <section id="faq" className="bg-[color:var(--paper-1)] px-6 py-24 md:px-12">
      <div className="mx-auto max-w-3xl">
        <p className="story-eyebrow text-[color:var(--story-teal-ink)]">
          Questions
        </p>
        <h2 className="story-h text-[color:var(--ink-900)]">
          What people ask about this build.
        </h2>

        <dl className="mt-12 border-t border-[color:var(--paper-line)]">
          {faqs.map((f) => (
            <div
              key={f.question}
              className="border-b border-[color:var(--paper-line)] py-7"
            >
              <dt className="[font-family:var(--font-fraunces),serif] text-[1.15rem] font-semibold text-[color:var(--ink-900)]">
                {f.question}
              </dt>
              <dd className="story-sub mt-3 text-[color:var(--ink-600)]">
                {f.answer}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
