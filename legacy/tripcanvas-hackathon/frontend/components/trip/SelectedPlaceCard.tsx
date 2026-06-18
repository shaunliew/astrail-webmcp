import type { TripPlace } from "@/lib/trip/types";

type SelectedPlaceCardProps = {
  place: TripPlace | null;
  onViewIntel?: () => void;
};

export function SelectedPlaceCard({ place, onViewIntel }: SelectedPlaceCardProps) {
  if (!place) {
    return null;
  }

  return (
    <section className="absolute bottom-[188px] left-1/2 z-10 w-[min(590px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-white/10 bg-slate-950/84 p-5 shadow-2xl shadow-black/40 backdrop-blur-xl md:bottom-[190px]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-black uppercase tracking-[0.34em] text-amber-200">
            Selected place
          </p>
          <h2 className="mt-2 truncate text-2xl font-black tracking-tight text-white">
            {place.name}
          </h2>
          <p className="mt-3 line-clamp-2 max-w-xl text-sm font-semibold leading-6 text-slate-300">
            {place.summary}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Pill>Day {place.day}</Pill>
          <Pill>{place.category}</Pill>
        </div>
      </div>
      {onViewIntel ? (
        <button
          type="button"
          onClick={onViewIntel}
          className="mt-4 h-10 rounded-xl border border-amber-200/35 bg-amber-200/14 px-4 text-xs font-black uppercase tracking-[0.18em] text-amber-100 transition hover:bg-amber-200/22"
        >
          View place intel
        </button>
      ) : null}
    </section>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/12 px-4 py-3 text-sm font-bold capitalize text-slate-100">
      {children}
    </span>
  );
}
