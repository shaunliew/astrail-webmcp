import WaitlistFormEmbed from "./WaitlistFormEmbed";

export default function WaitlistSection() {
  return (
    <section className="px-5 py-24 md:px-10" id="waitlist">
      <div className="section-frame mx-auto grid max-w-7xl gap-10 pt-16 lg:grid-cols-[0.86fr_0.64fr]">
        <div>
          <p className="type-label mb-5 text-xs uppercase tracking-[0.18em] text-[color:var(--brass)]">
            Start your trail
          </p>
          <h2 className="type-display max-w-3xl text-5xl font-normal leading-[0.96] md:text-7xl">
            Join the beta <span className="block sm:inline">waitlist.</span>
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-[color:var(--muted)]">
            We are opening Astrail slowly while we rebuild the hackathon
            prototype into something reliable enough for real trips. Leave your
            email and we will invite you when the beta opens.
          </p>
          <div className="type-label mt-10 grid gap-3 text-xs uppercase tracking-[0.14em] text-[rgba(242,236,224,0.42)] sm:grid-cols-3">
            <p>Email only</p>
            <p>No fake scarcity</p>
            <p>Beta invites first</p>
          </div>
        </div>
        <WaitlistFormEmbed />
      </div>
    </section>
  );
}
