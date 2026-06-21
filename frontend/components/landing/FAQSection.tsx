import { faqs } from "./landing-copy";

export default function FAQSection() {
  return (
    <section className="px-5 py-24 md:px-10">
      <div className="section-frame mx-auto max-w-5xl pt-16">
        <div className="mb-10 max-w-3xl">
          <p className="type-label mb-5 text-xs uppercase tracking-[0.18em] text-[color:var(--brass)]">
            Questions
          </p>
          <h2 className="type-display text-5xl font-normal leading-[0.96] md:text-6xl">
            What to know before joining.
          </h2>
        </div>
        <div className="divide-y divide-[color:var(--line)]">
          {faqs.map((faq, index) => (
            <article
              className="grid gap-4 py-8 md:grid-cols-[0.45fr_1fr]"
              key={faq.question}
            >
              <div>
                <p className="type-label mb-4 text-xs uppercase tracking-[0.16em] text-[color:var(--brass)]">
                  Q {String(index + 1).padStart(2, "0")}
                </p>
                <h3 className="type-display text-3xl font-normal leading-tight">
                  {faq.question}
                </h3>
              </div>
              <p className="leading-7 text-[color:var(--muted)]">
                {faq.answer}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
