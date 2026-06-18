import { buildPlaceIntel } from "@/lib/trip/place-intel";
import type { TripDay, TripPlace } from "@/lib/trip/types";

type PlaceIntelPanelProps = {
  place: TripPlace | null;
  days: TripDay[];
};

export function PlaceIntelPanel({ place, days }: PlaceIntelPanelProps) {
  if (!place) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/8 px-4 py-5 text-sm font-semibold leading-6 text-slate-300">
        Select a map place to see its agent-curated travel details.
      </div>
    );
  }

  const intel = buildPlaceIntel(place, days);
  const confidenceLabel =
    typeof place.confidence === "number" ? `${Math.round(place.confidence * 100)}%` : "Source";

  return (
    <div className="space-y-4">
      <header>
        <p className="text-xs font-black uppercase tracking-[0.28em] text-teal-200">
          Place Intel
        </p>
        <h2 className="mt-2 text-2xl font-black tracking-tight text-white">{place.name}</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Pill>Day {place.day}</Pill>
          <Pill>{place.category}</Pill>
          <Pill>{confidenceLabel}</Pill>
        </div>
      </header>

      <div className="overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-teal-300/14 via-white/8 to-amber-200/12 p-4">
        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-400">
          {intel.visual.label}
        </p>
        <p className="mt-2 text-sm font-semibold leading-6 text-slate-200">{intel.visual.detail}</p>
      </div>

      <IntelSection title="Why this stop">
        <p>{intel.whyThisStop}</p>
      </IntelSection>

      <div className="grid grid-cols-2 gap-3">
        <Metric label="Best time" value={intel.bestTime} />
        <Metric label="Duration" value={intel.suggestedDuration} />
      </div>

      <IntelSection title="How to go">
        <p>{intel.howToGo}</p>
        <a
          href={intel.directionsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex h-9 items-center rounded-lg border border-amber-200/35 bg-amber-200/15 px-3 text-xs font-black uppercase tracking-[0.16em] text-amber-100 transition hover:bg-amber-200/22"
        >
          Open directions
        </a>
      </IntelSection>

      <IntelSection title="Inside / nearby">
        <ul className="space-y-2">
          {intel.insideOrNearby.map((item) => (
            <li key={item} className="rounded-lg border border-white/8 bg-white/6 px-3 py-2">
              {item}
            </li>
          ))}
        </ul>
      </IntelSection>

      <IntelSection title="Evidence">
        {place.evidenceQuote ? <p>"{place.evidenceQuote}"</p> : <p>No Reel evidence quote was returned.</p>}
        <p className="mt-2 text-xs font-black uppercase tracking-[0.18em] text-slate-500">
          {intel.sourceLabel}
        </p>
        {place.sourceUrl ? (
          <a
            href={place.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex text-sm font-bold text-teal-100 underline decoration-teal-200/50 underline-offset-4"
          >
            View source
          </a>
        ) : null}
      </IntelSection>
    </div>
  );
}

function IntelSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/8 px-4 py-3 text-sm font-semibold leading-6 text-slate-300">
      <p className="mb-2 text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
        {title}
      </p>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/8 px-3 py-3">
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-sm font-black capitalize leading-5 text-slate-100">{value}</p>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/12 px-3 py-1 text-xs font-bold capitalize text-slate-100">
      {children}
    </span>
  );
}
