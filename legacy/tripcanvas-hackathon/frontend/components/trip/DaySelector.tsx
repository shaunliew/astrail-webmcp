import type { DayFilter, TripDay } from "@/lib/trip/types";

type DaySelectorProps = {
  days: TripDay[];
  selectedDay: DayFilter;
  onSelectDay: (day: DayFilter) => void;
};

export function DaySelector({ days, selectedDay, onSelectDay }: DaySelectorProps) {
  return (
    <div className="flex flex-wrap gap-3">
      <button type="button" onClick={() => onSelectDay("all")}>
        All
      </button>
      {days.map((day) => (
        <button key={day.day} type="button" onClick={() => onSelectDay(day.day)}>
          Day {day.day}
          {selectedDay === day.day ? " selected" : ""}
        </button>
      ))}
    </div>
  );
}
