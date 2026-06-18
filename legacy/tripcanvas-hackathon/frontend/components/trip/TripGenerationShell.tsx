"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { TripMap, type TripMapMode } from "@/components/map/TripMap";
import { BottomPlaceRail } from "@/components/trip/BottomPlaceRail";
import { RightTripPanel, type RightPanelTab } from "@/components/trip/RightTripPanel";
import { SelectedPlaceCard } from "@/components/trip/SelectedPlaceCard";
import { TripCanvasShell } from "@/components/trip/TripCanvasShell";
import type {
  BudgetLevel,
  ExtractResponse,
  ItineraryStreamEvent,
  UserPreferencesPayload,
} from "@/lib/trip/backend-types";
import {
  buildFinalTrip,
  buildPreferencesPayload,
  buildProvisionalTrip,
  extractReelPlaces,
  streamItinerary,
} from "@/lib/trip/generate-trip";
import type { TripExperience } from "@/lib/trip/types";

type GenerationStatus =
  | "idle_globe"
  | "extracting_places"
  | "zooming_to_destination"
  | "places_ready"
  | "planning_itinerary"
  | "trip_ready"
  | "error";

type GenerationLog = {
  id: string;
  title: string;
  detail: string;
  tone: "info" | "success" | "warning" | "error";
};

const EMPTY_GLOBE_TRIP: TripExperience = {
  id: "empty-globe",
  title: "TripCanvas",
  datesLabel: "Trip dates",
  destination: {
    city: "Earth",
    country: "",
    center: [103.8198, 1.3521],
    zoom: 1.35,
  },
  days: [],
  places: [],
};

const DEFAULT_REEL_INPUT = "";
const DEFAULT_START_DATE = "2026-06-10";
const DEFAULT_END_DATE = "2026-06-13";
const DEFAULT_BUDGET: BudgetLevel = "mid_range";
const DEFAULT_ORIGIN_CITY = "Singapore";
const DEFAULT_PREFERENCES = "Love ramen, onsen, walkable neighborhoods, and good hotel value.";

export function TripGenerationShell() {
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const abortControllerRef = useRef<AbortController | null>(null);
  const focusResolverRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef(0);
  const [status, setStatus] = useState<GenerationStatus>("idle_globe");
  const [reelInput, setReelInput] = useState(DEFAULT_REEL_INPUT);
  const [startDate, setStartDate] = useState(DEFAULT_START_DATE);
  const [endDate, setEndDate] = useState(DEFAULT_END_DATE);
  const [budgetLevel, setBudgetLevel] = useState<BudgetLevel>(DEFAULT_BUDGET);
  const [originCity, setOriginCity] = useState(DEFAULT_ORIGIN_CITY);
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [extractResponse, setExtractResponse] = useState<ExtractResponse | null>(null);
  const [preferencesPayload, setPreferencesPayload] = useState<UserPreferencesPayload | null>(null);
  const [provisionalTrip, setProvisionalTrip] = useState<TripExperience | null>(null);
  const [finalTrip, setFinalTrip] = useState<TripExperience | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("agent-run");
  const [logs, setLogs] = useState<GenerationLog[]>([]);
  const [streamElapsedSeconds, setStreamElapsedSeconds] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeTrip = provisionalTrip ?? EMPTY_GLOBE_TRIP;
  const selectedPlace = useMemo(
    () => activeTrip.places.find((place) => place.id === selectedPlaceId) ?? null,
    [activeTrip.places, selectedPlaceId],
  );
  const mapCenter = useMemo(
    () => ({
      lng: activeTrip.destination.center[0],
      lat: activeTrip.destination.center[1],
    }),
    [activeTrip.destination.center],
  );
  const mapMode = getMapMode(status, provisionalTrip);
  const isBusy =
    status === "extracting_places" ||
    status === "zooming_to_destination" ||
    status === "places_ready" ||
    status === "planning_itinerary";
  const cacheNotice = extractResponse?.source === "cache" ? "Cache fallback" : undefined;

  const pushLog = useCallback((title: string, detail: string, tone: GenerationLog["tone"]) => {
    setLogs((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        title,
        detail,
        tone,
      },
    ]);
  }, []);

  const waitForRegionFocus = useCallback(() => {
    return new Promise<void>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        focusResolverRef.current = null;
        resolve();
      }, 2600);

      focusResolverRef.current = () => {
        window.clearTimeout(timeoutId);
        focusResolverRef.current = null;
        resolve();
      };
    });
  }, []);

  const handleRegionFocusComplete = useCallback(() => {
    focusResolverRef.current?.();
  }, []);

  const handleStreamEvent = useCallback(
    (event: ItineraryStreamEvent) => {
      if (event.type === "start") {
        pushLog(
          "Planning started",
          `Using ${event.n_places_used ?? "selected"} of ${event.n_places_in ?? "the"} extracted places for ${event.destination ?? "the destination"}.`,
          "info",
        );
        return;
      }

      if (event.type === "heartbeat") {
        setStreamElapsedSeconds(typeof event.elapsed_s === "number" ? event.elapsed_s : null);
        return;
      }

      if (event.type === "result") {
        pushLog("Itinerary ready", "The planner returned the final day-by-day trip.", "success");
        return;
      }
    },
    [pushLog],
  );

  const handleSelectPlace = useCallback((placeId: string) => {
    setSelectedPlaceId(placeId);
    setRightPanelTab("place-intel");
  }, []);

  const handleViewIntel = useCallback(() => {
    setRightPanelTab("place-intel");
  }, []);

  const handleGenerate = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const reelUrls = parseReelUrls(reelInput);
      if (reelUrls.length === 0) {
        setStatus("error");
        setErrorMessage("Paste at least one Instagram Reel URL.");
        return;
      }

      if (reelUrls.length > 4) {
        setStatus("error");
        setErrorMessage("Use 1-4 Reel URLs for this demo flow.");
        return;
      }

      if (startDate > endDate) {
        setStatus("error");
        setErrorMessage("End date must be after the start date.");
        return;
      }

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const formValues = {
        reelUrls,
        startDate,
        endDate,
        budgetLevel,
        originCity,
        preferences,
      };
      const nextPreferences = buildPreferencesPayload(formValues);

      setErrorMessage(null);
      setExtractResponse(null);
      setPreferencesPayload(nextPreferences);
      setProvisionalTrip(null);
      setFinalTrip(null);
      setSelectedPlaceId(null);
      setRightPanelTab("agent-run");
      setStreamElapsedSeconds(null);
      setLogs([]);

      try {
        setStatus("extracting_places");
        pushLog(
          "Reading Reels",
          "The backend is scraping captions and creator location signals.",
          "info",
        );

        const extracted = await extractReelPlaces(reelUrls, controller.signal);
        if (runIdRef.current !== runId || controller.signal.aborted) {
          return;
        }

        const provisional = buildProvisionalTrip(extracted.places, nextPreferences);
        if (provisional.places.length === 0) {
          throw new Error("Extraction finished, but no places had valid coordinates.");
        }

        setExtractResponse(extracted);
        setProvisionalTrip(provisional);
        setSelectedPlaceId(provisional.places[0]?.id ?? null);
        setRightPanelTab("agent-run");
        pushLog(
          "Places mapped",
          `${provisional.places.length} geocoded places are ready for the map.`,
          extracted.source === "cache" ? "warning" : "success",
        );

        setStatus("zooming_to_destination");
        await waitForRegionFocus();
        if (runIdRef.current !== runId || controller.signal.aborted) {
          return;
        }

        setStatus("places_ready");
        await sleep(450);
        if (runIdRef.current !== runId || controller.signal.aborted) {
          return;
        }

        setStatus("planning_itinerary");
        pushLog(
          "Researching itinerary",
          "The planner is checking hotels, weather, flights, and place context.",
          "info",
        );

        const itinerary = await streamItinerary(
          {
            places: extracted.places,
            preferences: nextPreferences,
          },
          {
            signal: controller.signal,
            onEvent: handleStreamEvent,
          },
        );
        if (runIdRef.current !== runId || controller.signal.aborted) {
          return;
        }

        const trip = buildFinalTrip(extracted.places, itinerary, nextPreferences);
        setFinalTrip(trip);
        setSelectedPlaceId(trip.places[0]?.id ?? null);
        setStatus("trip_ready");
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setStatus("error");
        setErrorMessage(getErrorMessage(error));
        pushLog("Generation stopped", getErrorMessage(error), "error");
      }
    },
    [
      budgetLevel,
      endDate,
      handleStreamEvent,
      originCity,
      preferences,
      pushLog,
      reelInput,
      startDate,
      waitForRegionFocus,
    ],
  );

  if (!mapboxToken) {
    return <MissingMapboxToken />;
  }

  if (status === "trip_ready" && finalTrip) {
    return (
      <TripCanvasShell
        trip={finalTrip}
        dataNotice={cacheNotice}
        rightPanel={
          <AgentProgressPanel
            status={status}
            logs={logs}
            elapsedSeconds={streamElapsedSeconds}
            extractResponse={extractResponse}
            preferences={preferencesPayload}
          />
        }
      />
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#03050c] text-white">
      <TripMap
        mode={mapMode}
        mapboxToken={mapboxToken}
        center={mapCenter}
        initialZoom={activeTrip.destination.zoom}
        days={activeTrip.days}
        selectedDay="all"
        places={activeTrip.places}
        selectedPlace={selectedPlace}
        onSelectPlace={handleSelectPlace}
        onRegionFocusComplete={handleRegionFocusComplete}
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_36%,rgba(20,184,166,0.1),transparent_34%),linear-gradient(180deg,rgba(2,6,23,0.12),rgba(2,6,23,0.66))]" />
      {cacheNotice ? <SourceBadge label={cacheNotice} /> : null}
      <section
        className={[
          "absolute left-4 top-4 z-10 w-[calc(100vw-2rem)] max-w-[540px] transition duration-500 md:left-8 md:top-8",
          status === "zooming_to_destination"
            ? "pointer-events-none -translate-y-3 opacity-0"
            : "opacity-100",
        ].join(" ")}
      >
        <ReelInputPanel
          reelInput={reelInput}
          startDate={startDate}
          endDate={endDate}
          budgetLevel={budgetLevel}
          originCity={originCity}
          preferences={preferences}
          isBusy={isBusy}
          errorMessage={status === "error" ? errorMessage : null}
          onSubmit={handleGenerate}
          onReelInputChange={setReelInput}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
          onBudgetLevelChange={setBudgetLevel}
          onOriginCityChange={setOriginCity}
          onPreferencesChange={setPreferences}
        />
        <GenerationTimeline status={status} hasPlaces={activeTrip.places.length > 0} />
      </section>
      {status !== "idle_globe" ? (
        <RightTripPanel
          activeTab={rightPanelTab}
          agentPanelContent={
            <AgentProgressPanel
              status={status}
              logs={logs}
              elapsedSeconds={streamElapsedSeconds}
              extractResponse={extractResponse}
              preferences={preferencesPayload}
            />
          }
          days={activeTrip.days}
          selectedPlace={selectedPlace}
          onSelectTab={setRightPanelTab}
        />
      ) : null}
      <SelectedPlaceCard place={selectedPlace} onViewIntel={handleViewIntel} />
      <BottomPlaceRail
        places={activeTrip.places}
        selectedPlaceId={selectedPlaceId}
        onSelectPlace={handleSelectPlace}
      />
    </main>
  );
}

function ReelInputPanel({
  reelInput,
  startDate,
  endDate,
  budgetLevel,
  originCity,
  preferences,
  isBusy,
  errorMessage,
  onSubmit,
  onReelInputChange,
  onStartDateChange,
  onEndDateChange,
  onBudgetLevelChange,
  onOriginCityChange,
  onPreferencesChange,
}: {
  reelInput: string;
  startDate: string;
  endDate: string;
  budgetLevel: BudgetLevel;
  originCity: string;
  preferences: string;
  isBusy: boolean;
  errorMessage: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onReelInputChange: (value: string) => void;
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string) => void;
  onBudgetLevelChange: (value: BudgetLevel) => void;
  onOriginCityChange: (value: string) => void;
  onPreferencesChange: (value: string) => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="rounded-2xl border border-white/12 bg-slate-950/80 p-6 shadow-2xl shadow-black/45 backdrop-blur-xl"
    >
      <p className="text-xs font-black uppercase tracking-[0.34em] text-amber-200">
        TripCanvas
      </p>
      <h1 className="mt-3 text-4xl font-black tracking-tight text-white">
        Turn saved Reels into a live trip map
      </h1>
      <p className="mt-4 max-w-xl text-sm font-semibold leading-6 text-slate-300">
        Paste travel Reels and let the agent extract real places, zoom the globe, and build the itinerary.
      </p>

      <label className="mt-6 block">
        <span className="text-xs font-black uppercase tracking-[0.22em] text-slate-400">
          Instagram Reel URLs
        </span>
        <textarea
          value={reelInput}
          onChange={(event) => onReelInputChange(event.target.value)}
          disabled={isBusy}
          rows={4}
          placeholder="https://www.instagram.com/reel/..."
          className="mt-3 min-h-[118px] w-full resize-none rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-slate-500 focus:border-amber-200/60 disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Start date">
          <input
            type="date"
            value={startDate}
            onChange={(event) => onStartDateChange(event.target.value)}
            disabled={isBusy}
            className="field-input"
          />
        </Field>
        <Field label="End date">
          <input
            type="date"
            value={endDate}
            onChange={(event) => onEndDateChange(event.target.value)}
            disabled={isBusy}
            className="field-input"
          />
        </Field>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1.1fr]">
        <Field label="Budget">
          <select
            value={budgetLevel}
            onChange={(event) => onBudgetLevelChange(event.target.value as BudgetLevel)}
            disabled={isBusy}
            className="field-input"
          >
            <option value="budget">Budget</option>
            <option value="mid_range">Mid range</option>
            <option value="luxury">Luxury</option>
          </select>
        </Field>
        <Field label="Origin city">
          <input
            type="text"
            value={originCity}
            onChange={(event) => onOriginCityChange(event.target.value)}
            disabled={isBusy}
            placeholder="Singapore"
            className="field-input"
          />
        </Field>
      </div>

      <label className="mt-4 block">
        <span className="text-xs font-black uppercase tracking-[0.22em] text-slate-400">
          Preferences
        </span>
        <textarea
          value={preferences}
          onChange={(event) => onPreferencesChange(event.target.value)}
          disabled={isBusy}
          rows={3}
          className="mt-3 min-h-[86px] w-full resize-none rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-slate-500 focus:border-amber-200/60 disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>

      {errorMessage ? (
        <p className="mt-4 rounded-xl border border-red-300/30 bg-red-400/12 px-4 py-3 text-sm font-semibold leading-6 text-red-100">
          {errorMessage}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isBusy}
        className="mt-5 h-12 w-full rounded-xl border border-amber-100/30 bg-amber-200 px-5 text-base font-black text-slate-950 shadow-xl shadow-amber-950/25 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isBusy ? "Generating trip map" : "Generate trip map"}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">
        {label}
      </span>
      <div className="mt-2">{children}</div>
    </label>
  );
}

function GenerationTimeline({
  status,
  hasPlaces,
}: {
  status: GenerationStatus;
  hasPlaces: boolean;
}) {
  const steps = [
    {
      key: "extract",
      label: "Extract places",
      active: status === "extracting_places",
      done: hasPlaces,
    },
    {
      key: "zoom",
      label: "Zoom to region",
      active: status === "zooming_to_destination",
      done: hasPlaces && status !== "zooming_to_destination" && status !== "extracting_places",
    },
    {
      key: "plan",
      label: "Plan itinerary",
      active: status === "planning_itinerary",
      done: status === "trip_ready",
    },
    {
      key: "map",
      label: "Render map",
      active: status === "trip_ready",
      done: status === "trip_ready",
    },
  ];

  return (
    <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/72 p-4 shadow-2xl shadow-black/30 backdrop-blur-xl">
      <div className="grid gap-3 sm:grid-cols-4">
        {steps.map((step) => (
          <div
            key={step.key}
            className={[
              "rounded-xl border px-3 py-3",
              step.done
                ? "border-teal-200/30 bg-teal-300/12 text-teal-100"
                : step.active
                  ? "border-amber-200/40 bg-amber-200/14 text-amber-100"
                  : "border-white/10 bg-white/6 text-slate-400",
            ].join(" ")}
          >
            <div className="flex items-center gap-2">
              <span
                className={[
                  "h-2.5 w-2.5 rounded-full",
                  step.done
                    ? "bg-teal-200"
                    : step.active
                      ? "animate-pulse bg-amber-200"
                      : "bg-slate-600",
                ].join(" ")}
              />
              <p className="text-xs font-black uppercase tracking-[0.16em]">{step.label}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentProgressPanel({
  status,
  logs,
  elapsedSeconds,
  extractResponse,
  preferences,
}: {
  status: GenerationStatus;
  logs: GenerationLog[];
  elapsedSeconds: number | null;
  extractResponse: ExtractResponse | null;
  preferences: UserPreferencesPayload | null;
}) {
  if (status === "idle_globe") {
    return null;
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.28em] text-teal-200">
            Agent run
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-white">
            {getAgentPanelTitle(status)}
          </h2>
        </div>
        {elapsedSeconds !== null ? (
          <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs font-bold text-slate-200">
            {elapsedSeconds.toFixed(1)}s
          </span>
        ) : null}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Metric label="Places" value={String(extractResponse?.count ?? "-")} />
        <Metric label="Source" value={extractResponse?.source ?? "-"} />
        <Metric label="Dates" value={preferences ? `${preferences.start_date.slice(5)}-${preferences.end_date.slice(5)}` : "-"} />
        <Metric label="Budget" value={preferences?.budget_level.replace("_", " ") ?? "-"} />
      </div>

      <div className="mt-5 space-y-3">
        {logs.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-white/8 px-4 py-3 text-sm font-semibold leading-6 text-slate-300">
            Waiting for the first backend event.
          </p>
        ) : (
          logs.slice(-5).map((log) => (
            <div
              key={log.id}
              className={[
                "rounded-xl border px-4 py-3",
                log.tone === "success"
                  ? "border-teal-200/25 bg-teal-300/10"
                  : log.tone === "warning"
                    ? "border-amber-200/30 bg-amber-200/12"
                    : log.tone === "error"
                      ? "border-red-300/30 bg-red-400/12"
                      : "border-white/10 bg-white/8",
              ].join(" ")}
            >
              <p className="text-sm font-black text-white">{log.title}</p>
              <p className="mt-1 text-sm font-semibold leading-6 text-slate-300">
                {log.detail}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/8 px-3 py-3">
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-black capitalize text-slate-100">{value}</p>
    </div>
  );
}

function SourceBadge({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-amber-200/30 bg-slate-950/[0.78] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-amber-100 shadow-2xl shadow-black/30 backdrop-blur-xl lg:right-[430px]">
      {label}
    </div>
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

function getMapMode(status: GenerationStatus, provisionalTrip: TripExperience | null): TripMapMode {
  if (!provisionalTrip || status === "idle_globe" || status === "extracting_places") {
    return "globe";
  }

  if (status === "zooming_to_destination") {
    return "extracting";
  }

  return "trip";
}

function getAgentPanelTitle(status: GenerationStatus) {
  if (status === "extracting_places") {
    return "Finding real places";
  }

  if (status === "zooming_to_destination") {
    return "Grounding the map";
  }

  if (status === "planning_itinerary") {
    return "Researching the trip";
  }

  if (status === "trip_ready") {
    return "Trip ready";
  }

  if (status === "error") {
    return "Needs attention";
  }

  return "Preparing";
}

function parseReelUrls(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\s,]+/)
        .map((url) => url.trim())
        .filter(Boolean),
    ),
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong while generating the trip.";
}
