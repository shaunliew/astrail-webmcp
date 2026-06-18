import type { TripPlace } from "@/lib/trip/types";

type BottomPlaceRailProps = {
  places: TripPlace[];
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
};

export function BottomPlaceRail({ places, selectedPlaceId, onSelectPlace }: BottomPlaceRailProps) {
  if (places.length === 0) {
    return null;
  }

  return (
    <nav className="absolute bottom-5 left-4 right-4 z-10 flex gap-4 overflow-x-auto pb-1">
      {places.map((place) => {
        const selected = place.id === selectedPlaceId;

        return (
          <button
            key={place.id}
            type="button"
            onClick={() => onSelectPlace(place.id)}
            className={[
              "grid h-[104px] min-w-[315px] max-w-[315px] grid-rows-[auto_auto_1fr] rounded-xl border p-4 text-left shadow-2xl shadow-black/30 backdrop-blur-xl transition",
              selected
                ? "border-amber-200 bg-slate-950/88"
                : "border-white/10 bg-slate-950/76 hover:bg-slate-900/82",
            ].join(" ")}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-black uppercase tracking-[0.22em] text-amber-200">
                Day {place.day}
              </span>
              <span className="rounded-full border border-white/10 bg-white/12 px-3 py-1 text-xs font-bold capitalize text-slate-100">
                {place.category}
              </span>
            </div>
            <h3 className="mt-3 truncate text-xl font-black text-white">{place.name}</h3>
            <p className="mt-2 line-clamp-2 text-sm font-semibold leading-5 text-slate-300">
              {place.summary}
            </p>
          </button>
        );
      })}
    </nav>
  );
}
