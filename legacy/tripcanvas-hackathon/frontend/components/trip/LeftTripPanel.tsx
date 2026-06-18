import type {
  CategoryFilter,
  DayFilter,
  PlaceCategory,
  TripExperience,
} from "@/lib/trip/types";

type LeftTripPanelProps = {
  trip: TripExperience;
  selectedDay: DayFilter;
  activeCategory: CategoryFilter;
  categories: PlaceCategory[];
  visiblePlaceCount: number;
  onSelectDay: (day: DayFilter) => void;
  onSelectCategory: (category: CategoryFilter) => void;
};

export function LeftTripPanel({
  trip,
  selectedDay,
  activeCategory,
  categories,
  visiblePlaceCount,
  onSelectDay,
  onSelectCategory,
}: LeftTripPanelProps) {
  const activeDay =
    selectedDay === "all" ? null : trip.days.find((day) => day.day === selectedDay) ?? null;

  return (
    <aside className="absolute left-4 top-4 z-10 w-[calc(100vw-2rem)] max-w-[510px] rounded-2xl border border-white/10 bg-slate-950/78 p-6 shadow-2xl shadow-black/35 backdrop-blur-xl md:left-8 md:top-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-black uppercase tracking-[0.38em] text-amber-200">
            TripCanvas
          </p>
          <h1 className="mt-3 text-4xl font-black tracking-tight text-white">{trip.title}</h1>
          <p className="mt-6 text-lg font-semibold text-slate-300">
            {trip.destination.city}, {trip.destination.country} - {trip.datesLabel}
          </p>
        </div>
        <span className="rounded-full border border-teal-200/30 bg-teal-300/15 px-4 py-2 text-sm font-bold text-teal-100">
          Live map
        </span>
      </div>

      <section className="mt-8">
        <p className="mb-4 text-sm font-black uppercase tracking-[0.36em] text-slate-400">Days</p>
        <div className="flex flex-wrap gap-3">
          <FilterButton active={selectedDay === "all"} onClick={() => onSelectDay("all")}>
            All
          </FilterButton>
          {trip.days.map((day) => (
            <FilterButton
              key={day.day}
              active={selectedDay === day.day}
              onClick={() => onSelectDay(day.day)}
            >
              Day {day.day}
            </FilterButton>
          ))}
        </div>
        {activeDay ? (
          <div className="mt-4 rounded-xl border border-white/10 bg-white/8 p-4">
            <p className="text-sm font-black uppercase tracking-[0.22em] text-amber-200">
              {activeDay.title}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-300">{activeDay.summary}</p>
          </div>
        ) : null}
      </section>

      <section className="mt-7">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-black uppercase tracking-[0.36em] text-slate-400">
            Categories
          </p>
          <span className="text-sm font-semibold text-slate-400">{visiblePlaceCount} visible</span>
        </div>
        <div className="flex flex-wrap gap-3">
          <FilterButton active={activeCategory === "all"} onClick={() => onSelectCategory("all")}>
            All
          </FilterButton>
          {categories.map((category) => (
            <FilterButton
              key={category}
              active={activeCategory === category}
              onClick={() => onSelectCategory(category)}
            >
              {category}
            </FilterButton>
          ))}
        </div>
      </section>
    </aside>
  );
}

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-full border px-5 py-3 text-xl font-semibold capitalize shadow-lg transition",
        active
          ? "border-amber-200 bg-amber-200/18 text-white"
          : "border-white/10 bg-white/10 text-slate-200 hover:bg-white/16",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
