"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TripMap } from "@/components/map/TripMap";
import { BottomPlaceRail } from "@/components/trip/BottomPlaceRail";
import { LeftTripPanel } from "@/components/trip/LeftTripPanel";
import { RightTripPanel, type RightPanelTab } from "@/components/trip/RightTripPanel";
import { SelectedPlaceCard } from "@/components/trip/SelectedPlaceCard";
import type {
  CategoryFilter,
  DayFilter,
  PlaceCategory,
  TripExperience,
} from "@/lib/trip/types";

type TripCanvasShellProps = {
  trip: TripExperience;
  dataNotice?: string;
  rightPanel?: React.ReactNode;
};

export function TripCanvasShell({ trip, dataNotice, rightPanel }: TripCanvasShellProps) {
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const [selectedDay, setSelectedDay] = useState<DayFilter>("all");
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>("all");
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(
    trip.places[0]?.id ?? null,
  );
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>(
    rightPanel ? "agent-run" : "place-intel",
  );

  const categories = useMemo(
    () => Array.from(new Set(trip.places.map((place) => place.category))) as PlaceCategory[],
    [trip.places],
  );

  const mapCenter = useMemo(
    () => ({
      lng: trip.destination.center[0],
      lat: trip.destination.center[1],
    }),
    [trip.destination.center],
  );

  const dayFilteredPlaces = useMemo(
    () =>
      selectedDay === "all"
        ? trip.places
        : trip.places.filter((place) => place.day === selectedDay),
    [selectedDay, trip.places],
  );

  const visiblePlaces = useMemo(
    () =>
      activeCategory === "all"
        ? dayFilteredPlaces
        : dayFilteredPlaces.filter((place) => place.category === activeCategory),
    [activeCategory, dayFilteredPlaces],
  );

  const selectedPlace = useMemo(
    () => visiblePlaces.find((place) => place.id === selectedPlaceId) ?? null,
    [selectedPlaceId, visiblePlaces],
  );

  useEffect(() => {
    if (visiblePlaces.length === 0) {
      if (selectedPlaceId !== null) {
        setSelectedPlaceId(null);
      }
      return;
    }

    if (!selectedPlaceId || !visiblePlaces.some((place) => place.id === selectedPlaceId)) {
      setSelectedPlaceId(visiblePlaces[0].id);
    }
  }, [selectedPlaceId, visiblePlaces]);

  const handleSelectDay = useCallback((day: DayFilter) => {
    setSelectedDay(day);
    setActiveCategory("all");
  }, []);

  const handleSelectCategory = useCallback((category: CategoryFilter) => {
    setActiveCategory(category);
  }, []);

  const handleSelectPlace = useCallback((placeId: string) => {
    setSelectedPlaceId(placeId);
    setRightPanelTab("place-intel");
  }, []);

  const handleViewIntel = useCallback(() => {
    setRightPanelTab("place-intel");
  }, []);

  useEffect(() => {
    if (!rightPanel && rightPanelTab === "agent-run") {
      setRightPanelTab("place-intel");
    }
  }, [rightPanel, rightPanelTab]);

  if (!mapboxToken) {
    return <MissingMapboxToken />;
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#06070a] text-white">
      <TripMap
        mapboxToken={mapboxToken}
        center={mapCenter}
        initialZoom={trip.destination.zoom}
        days={trip.days}
        selectedDay={selectedDay}
        places={visiblePlaces}
        selectedPlace={selectedPlace}
        onSelectPlace={handleSelectPlace}
      />
      {dataNotice ? (
        <div className="pointer-events-none absolute right-3 top-3 rounded-full border border-amber-200/30 bg-slate-950/[0.72] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-amber-100 shadow-2xl shadow-black/30 backdrop-blur-xl md:right-5 md:top-5">
          {dataNotice}
        </div>
      ) : null}
      <LeftTripPanel
        trip={trip}
        selectedDay={selectedDay}
        activeCategory={activeCategory}
        categories={categories}
        visiblePlaceCount={visiblePlaces.length}
        onSelectDay={handleSelectDay}
        onSelectCategory={handleSelectCategory}
      />
      <RightTripPanel
        activeTab={rightPanelTab}
        agentPanelContent={rightPanel}
        days={trip.days}
        selectedPlace={selectedPlace}
        onSelectTab={setRightPanelTab}
      />
      <SelectedPlaceCard place={selectedPlace} onViewIntel={handleViewIntel} />
      <BottomPlaceRail
        places={visiblePlaces}
        selectedPlaceId={selectedPlaceId}
        onSelectPlace={handleSelectPlace}
      />
    </main>
  );
}

function MissingMapboxToken() {
  return (
    <main className="min-h-screen bg-[#06070a] text-white">
      <div className="flex min-h-screen items-center justify-center px-6">
        <section className="w-full max-w-lg rounded-2xl border border-white/[0.12] bg-white/[0.07] p-8 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-amber-200">
            Map token required
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">TripCanvas needs Mapbox</h1>
          <p className="mt-4 text-sm leading-6 text-slate-300">
            Add a public Mapbox token to{" "}
            <code className="rounded bg-white/10 px-1.5 py-1 text-amber-100">
              frontend/.env.local
            </code>{" "}
            and restart the Next.js dev server.
          </p>
          <pre className="mt-5 overflow-x-auto rounded-xl border border-white/10 bg-black/[0.35] p-4 text-sm text-slate-200">
            NEXT_PUBLIC_MAPBOX_TOKEN=your_mapbox_public_token_here
          </pre>
        </section>
      </div>
    </main>
  );
}
