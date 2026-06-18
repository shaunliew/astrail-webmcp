"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AnyLayer,
  ExpressionSpecification,
  GeoJSONSource,
  Map,
  MapEventOf,
  MapLayerMouseEvent,
} from "mapbox-gl";
import type { DayFilter, TripDay, TripPlace } from "@/lib/trip/types";

export type TripMapMode = "globe" | "extracting" | "trip";

type TripMapProps = {
  mode?: TripMapMode;
  mapboxToken: string;
  center: {
    lat: number;
    lng: number;
  };
  initialZoom: number;
  days: TripDay[];
  selectedDay: DayFilter;
  places: TripPlace[];
  selectedPlace: TripPlace | null;
  onSelectPlace: (placeId: string) => void;
  onRegionFocusComplete?: () => void;
};

type RouteFeatureProperties = {
  day: number;
  active: boolean;
};
type RouteFeatureCollection = GeoJSON.FeatureCollection<
  GeoJSON.LineString,
  RouteFeatureProperties
>;
type PlaceFeatureProperties = {
  placeId: string;
  name: string;
  category: TripPlace["category"];
  day: number;
  glyph: string;
  selected: boolean;
};
type PlaceFeatureCollection = GeoJSON.FeatureCollection<
  GeoJSON.Point,
  PlaceFeatureProperties
>;

const STANDARD_DAY_PITCH = 56;
const STANDARD_DAY_BEARING = -22;
const SELECTED_PLACE_PITCH = 60;
const SELECTED_PLACE_BEARING = -30;
const GLOBE_ZOOM = 1.28;
const GLOBE_PITCH = 0;
const GLOBE_BEARING = -24;
const STANDARD_ARCHITECTURAL_BASEMAP_CONFIG = {
  lightPreset: "day",
  theme: "default",
  show3dBuildings: true,
  show3dFacades: true,
  show3dLandmarks: true,
  show3dTrees: false,
  showPlaceLabels: true,
  showPointOfInterestLabels: true,
  showLandmarkIcons: true,
  showLandmarkIconLabels: true,
  showRoadLabels: true,
  showTransitLabels: true,
  showPedestrianRoads: true,
};
const USE_SAFE_3D_FALLBACK = false;
const RELIABLE_BUILDINGS_LAYER_ID = "tripcanvas-reliable-3d-buildings";
const ROUTE_SOURCE_ID = "tripcanvas-routes";
const ROUTE_UNDERLAY_LAYER_ID = "tripcanvas-routes-underlay";
const ROUTE_ACTIVE_LAYER_ID = "tripcanvas-routes-active";
const PLACE_SOURCE_ID = "tripcanvas-places";
const PLACE_CLUSTER_LAYER_ID = "tripcanvas-place-clusters";
const PLACE_CLUSTER_COUNT_LAYER_ID = "tripcanvas-place-cluster-counts";
const PLACE_CLUSTER_HITBOX_LAYER_ID = "tripcanvas-place-cluster-hitbox";
const PLACE_HALO_LAYER_ID = "tripcanvas-place-halos";
const PLACE_DOT_LAYER_ID = "tripcanvas-place-dots";
const PLACE_GLYPH_LAYER_ID = "tripcanvas-place-glyphs";
const PLACE_HITBOX_LAYER_ID = "tripcanvas-place-hitbox";
const EMPTY_ROUTE_COLLECTION: RouteFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
const EMPTY_PLACE_COLLECTION: PlaceFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export function TripMap({
  mode = "trip",
  mapboxToken,
  center,
  initialZoom,
  days,
  selectedDay,
  places,
  selectedPlace,
  onSelectPlace,
  onRegionFocusComplete,
}: TripMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const onSelectPlaceRef = useRef(onSelectPlace);
  const onRegionFocusCompleteRef = useRef(onRegionFocusComplete);
  const cleanupMapRuntimeGuardsRef = useRef<(() => void) | null>(null);
  const previousFlyToPlaceIdRef = useRef<string | null>(null);
  const focusedPlaceSignatureRef = useRef<string | null>(null);
  const autoRotateFrameRef = useRef<number | null>(null);
  const prefersReducedMotionRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const routeCollection = useMemo(
    () => buildRouteFeatureCollection(days, selectedDay),
    [days, selectedDay],
  );
  const placeCollection = useMemo(
    () => buildPlaceFeatureCollection(places, selectedPlace?.id ?? null),
    [places, selectedPlace?.id],
  );

  useEffect(() => {
    onSelectPlaceRef.current = onSelectPlace;
  }, [onSelectPlace]);

  useEffect(() => {
    onRegionFocusCompleteRef.current = onRegionFocusComplete;
  }, [onRegionFocusComplete]);

  useEffect(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotionPreference = () => {
      prefersReducedMotionRef.current = motionQuery.matches;
    };

    updateMotionPreference();
    motionQuery.addEventListener("change", updateMotionPreference);

    return () => {
      motionQuery.removeEventListener("change", updateMotionPreference);
    };
  }, []);

  useEffect(() => {
    if (!mapboxToken || mapRef.current || !mapContainerRef.current) {
      return;
    }

    let isMounted = true;

    async function initializeMap() {
      const mapboxModule = await import("mapbox-gl");
      const mapboxgl = mapboxModule.default;

      if (!isMounted || !mapContainerRef.current || mapRef.current) {
        return;
      }

      mapboxgl.accessToken = mapboxToken;

      const map = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: "mapbox://styles/mapbox/standard",
        config: {
          basemap: getBasemapConfig(mode),
        },
        center: [center.lng, center.lat],
        zoom: getInitialCameraZoom(initialZoom, mode),
        pitch: getInitialCameraPitch(mode),
        bearing: getInitialCameraBearing(mode),
        projection: mode === "trip" ? "mercator" : "globe",
        antialias: true,
        attributionControl: false,
        maxPitch: 75,
      });

      map.addControl(
        new mapboxgl.NavigationControl({
          visualizePitch: true,
        }),
        "bottom-left",
      );

      map.addControl(
        new mapboxgl.AttributionControl({
          compact: true,
        }),
        "bottom-right",
      );

      mapRef.current = map;
      cleanupMapRuntimeGuardsRef.current = registerMapRuntimeGuards(map);

      map.once("load", () => {
        applyAtmosphere(map, mode);
        if (USE_SAFE_3D_FALLBACK) {
          addReliable3DBuildingsLayer(map);
        }
        ensureRouteLayers(map);
        ensurePlaceLayers(map);
        registerPlaceInteractions(map, prefersReducedMotionRef, onSelectPlaceRef);
        map.resize();
        if (isMounted) {
          setMapReady(true);
        }
      });

      requestAnimationFrame(() => {
        map.resize();
      });
    }

    initializeMap().catch((error: unknown) => {
      if (!isMounted) {
        return;
      }

      console.warn(
        "[TripCanvas map] Map initialization failed.",
        getUnknownErrorMessage(error),
      );
    });

    return () => {
      isMounted = false;
      cleanupMapRuntimeGuardsRef.current?.();
      cleanupMapRuntimeGuardsRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [mapboxToken]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      return;
    }

    const map = mapRef.current;
    map.setProjection(mode === "trip" ? "mercator" : "globe");
    applyAtmosphere(map, mode);

    if (mode === "globe" && places.length === 0) {
      const globeCamera = {
        center: [center.lng, center.lat] as [number, number],
        zoom: GLOBE_ZOOM,
        pitch: GLOBE_PITCH,
        bearing: GLOBE_BEARING,
      } satisfies Parameters<Map["jumpTo"]>[0];

      if (prefersReducedMotionRef.current) {
        map.jumpTo(globeCamera);
        return;
      }

      map.easeTo({
        ...globeCamera,
        duration: 900,
        essential: false,
      });
    }
  }, [center.lat, center.lng, mapReady, mode, places.length]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || mode !== "globe" || places.length > 0) {
      if (autoRotateFrameRef.current !== null) {
        cancelAnimationFrame(autoRotateFrameRef.current);
        autoRotateFrameRef.current = null;
      }
      return;
    }

    if (prefersReducedMotionRef.current) {
      return;
    }

    const map = mapRef.current;
    const rotate = () => {
      map.setBearing((map.getBearing() + 0.018) % 360);
      autoRotateFrameRef.current = requestAnimationFrame(rotate);
    };

    autoRotateFrameRef.current = requestAnimationFrame(rotate);

    return () => {
      if (autoRotateFrameRef.current !== null) {
        cancelAnimationFrame(autoRotateFrameRef.current);
        autoRotateFrameRef.current = null;
      }
    };
  }, [mapReady, mode, places.length]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      return;
    }

    const map = mapRef.current;
    ensureRouteLayers(map);

    const source = map.getSource(ROUTE_SOURCE_ID);
    if (source && "setData" in source) {
      (source as GeoJSONSource).setData(routeCollection);
    }
  }, [mapReady, routeCollection]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      return;
    }

    const map = mapRef.current;
    ensurePlaceLayers(map);
    updatePlaceSource(map, placeCollection);
  }, [mapReady, placeCollection]);

  useEffect(() => {
    if (mode !== "trip" || !mapReady || !mapRef.current || !selectedPlace) {
      if (!selectedPlace) {
        previousFlyToPlaceIdRef.current = null;
      }
      return;
    }

    if (previousFlyToPlaceIdRef.current === selectedPlace.id) {
      return;
    }

    previousFlyToPlaceIdRef.current = selectedPlace.id;
    const selectedCamera = {
      center: [selectedPlace.lng, selectedPlace.lat] as [number, number],
      zoom: getSelectedPlaceZoom(initialZoom),
      pitch: SELECTED_PLACE_PITCH,
      bearing: SELECTED_PLACE_BEARING,
    } satisfies Parameters<Map["jumpTo"]>[0];

    if (prefersReducedMotionRef.current) {
      mapRef.current.jumpTo(selectedCamera);
      return;
    }

    mapRef.current.flyTo({
      ...selectedCamera,
      duration: 1400,
      essential: false,
    });
  }, [initialZoom, mapReady, mode, selectedPlace]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || mode !== "extracting" || places.length === 0) {
      return;
    }

    const bounds = getPlacesBounds(places);
    if (!bounds) {
      return;
    }

    const signature = places
      .map((place) => `${place.id}:${place.lng.toFixed(4)},${place.lat.toFixed(4)}`)
      .join("|");

    if (focusedPlaceSignatureRef.current === signature) {
      return;
    }

    focusedPlaceSignatureRef.current = signature;
    previousFlyToPlaceIdRef.current = null;

    const map = mapRef.current;
    const complete = () => {
      map.off("moveend", complete);
      onRegionFocusCompleteRef.current?.();
    };
    const padding = getRegionFocusPadding();

    if (prefersReducedMotionRef.current) {
      map.fitBounds(bounds, {
        padding,
        maxZoom: 12.8,
        duration: 0,
      });
      window.setTimeout(() => onRegionFocusCompleteRef.current?.(), 0);
      return;
    }

    map.once("moveend", complete);
    map.fitBounds(bounds, {
      padding,
      maxZoom: 12.8,
      duration: 2200,
      essential: false,
    });
  }, [mapReady, mode, places]);

  return (
    <>
      <div className="absolute inset-0 h-screen w-screen">
        <div
          ref={mapContainerRef}
          data-trip-map-container
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
          }}
        />
      </div>
      <div className="tc-map-vignette pointer-events-none absolute inset-0" />
    </>
  );
}

function registerMapRuntimeGuards(map: Map) {
  const handleMapError = (event: MapEventOf<"error">) => {
    const message = getUnknownErrorMessage(event.error);

    if (isExpectedMapboxRuntimeNoise(message)) {
      return;
    }

    console.warn("[TripCanvas map]", message || "Mapbox emitted an error event.");
  };

  const handleWebGlContextLost = (event: MapEventOf<"webglcontextlost">) => {
    event.originalEvent?.preventDefault();
  };

  const handleCanvasRuntimeEvent = (event: Event) => {
    if (event.type === "webglcontextlost") {
      event.preventDefault();
    }

    event.stopPropagation();
  };

  const canvas = map.getCanvas();
  map.on("error", handleMapError);
  map.on("webglcontextlost", handleWebGlContextLost);
  canvas.addEventListener("error", handleCanvasRuntimeEvent, true);
  canvas.addEventListener("webglcontextlost", handleCanvasRuntimeEvent, false);

  return () => {
    map.off("error", handleMapError);
    map.off("webglcontextlost", handleWebGlContextLost);
    canvas.removeEventListener("error", handleCanvasRuntimeEvent, true);
    canvas.removeEventListener("webglcontextlost", handleCanvasRuntimeEvent, false);
  };
}

function getUnknownErrorMessage(value: unknown) {
  if (!value) {
    return "";
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof Event !== "undefined" && value instanceof Event) {
    return `${value.type || "unknown"} event`;
  }

  if (typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return String(value);
}

function isExpectedMapboxRuntimeNoise(message: string) {
  return [
    "e.json.meshes is not iterable",
    "Failed to evaluate expression",
    "Cutoff is currently disabled on terrain",
  ].some((pattern) => message.includes(pattern));
}

function applyAtmosphere(map: Map, mode: TripMapMode) {
  try {
    if (mode === "trip") {
      map.setFog({
        color: "rgb(232, 242, 248)",
        "high-color": "rgb(188, 219, 235)",
        "horizon-blend": 0.08,
        "space-color": "rgb(246, 251, 255)",
        "star-intensity": 0,
      });
      return;
    }

    map.setFog({
      color: "rgb(15, 23, 42)",
      "high-color": "rgb(13, 148, 136)",
      "horizon-blend": 0.16,
      "space-color": "rgb(2, 6, 23)",
      "star-intensity": 0.38,
    });
  } catch {
    // Some Mapbox styles can reject fog options; the base map should still render.
  }
}

function getBasemapConfig(mode: TripMapMode) {
  if (mode === "trip") {
    return STANDARD_ARCHITECTURAL_BASEMAP_CONFIG;
  }

  return {
    ...STANDARD_ARCHITECTURAL_BASEMAP_CONFIG,
    lightPreset: "night",
    show3dBuildings: false,
    show3dFacades: false,
    show3dLandmarks: false,
    show3dTrees: false,
    showRoadLabels: false,
    showTransitLabels: false,
    showPedestrianRoads: false,
  };
}

function addReliable3DBuildingsLayer(map: Map) {
  if (map.getLayer(RELIABLE_BUILDINGS_LAYER_ID)) {
    return;
  }

  const hasCompositeSource = Boolean(map.getStyle().sources?.composite);
  if (!hasCompositeSource) {
    return;
  }

  const buildingLayer: AnyLayer = {
    id: RELIABLE_BUILDINGS_LAYER_ID,
    source: "composite",
    "source-layer": "building",
    filter: ["==", ["get", "extrude"], "true"],
    type: "fill-extrusion",
    minzoom: 13.4,
    slot: "middle",
    paint: {
      "fill-extrusion-color": [
        "interpolate",
        ["linear"],
        ["get", "height"],
        0,
        "#f4efe6",
        90,
        "#e8dfcf",
        180,
        "#d5c3a8",
        280,
        "#b9d7e8",
      ],
      "fill-extrusion-height": [
        "interpolate",
        ["linear"],
        ["zoom"],
        13.4,
        0,
        15.4,
        ["coalesce", ["get", "height"], 12],
      ],
      "fill-extrusion-base": [
        "interpolate",
        ["linear"],
        ["zoom"],
        13.4,
        0,
        15.4,
        ["coalesce", ["get", "min_height"], 0],
      ],
      "fill-extrusion-opacity": 0.74,
      "fill-extrusion-vertical-gradient": true,
      "fill-extrusion-emissive-strength": 0.05,
    },
  };

  try {
    map.addLayer(buildingLayer);
  } catch {
    // Some Mapbox Standard imports may hide the raw building source; the map stays usable.
  }
}

function ensureRouteLayers(map: Map) {
  if (!map.getSource(ROUTE_SOURCE_ID)) {
    map.addSource(ROUTE_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_ROUTE_COLLECTION,
      lineMetrics: true,
    });
  }

  if (!map.getLayer(ROUTE_UNDERLAY_LAYER_ID)) {
    map.addLayer({
      id: ROUTE_UNDERLAY_LAYER_ID,
      type: "line",
      source: ROUTE_SOURCE_ID,
      slot: "middle",
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": [
          "case",
          ["boolean", ["get", "active"], false],
          "rgba(245, 158, 11, 0.56)",
          "rgba(20, 184, 166, 0.34)",
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 7, 16, 10],
        "line-opacity": [
          "case",
          ["boolean", ["get", "active"], false],
          0.82,
          0.56,
        ],
        "line-blur": 1.8,
        "line-emissive-strength": 0.45,
      },
    });
  }

  if (!map.getLayer(ROUTE_ACTIVE_LAYER_ID)) {
    map.addLayer({
      id: ROUTE_ACTIVE_LAYER_ID,
      type: "line",
      source: ROUTE_SOURCE_ID,
      slot: "middle",
      filter: ["==", ["get", "active"], true],
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": "#f59e0b",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.2, 14, 4.8, 16, 7],
        "line-opacity": 0.96,
        "line-emissive-strength": 0.65,
      },
    });
  }
}

function ensurePlaceLayers(map: Map) {
  if (!map.getSource(PLACE_SOURCE_ID)) {
    map.addSource(PLACE_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_PLACE_COLLECTION,
      cluster: true,
      clusterRadius: 80,
      clusterMaxZoom: 11,
      clusterMinPoints: 2,
    });
  }

  const clusterLayer: AnyLayer = {
    id: PLACE_CLUSTER_LAYER_ID,
    type: "circle",
    source: PLACE_SOURCE_ID,
    slot: "top",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": [
        "step",
        ["get", "point_count"],
        "#fde68a",
        4,
        "#facc15",
        8,
        "#fb923c",
      ],
      "circle-radius": ["step", ["get", "point_count"], 23, 4, 28, 8, 34],
      "circle-opacity": 0.94,
      "circle-stroke-color": "rgba(15, 23, 42, 0.76)",
      "circle-stroke-width": 2,
      "circle-blur": 0.02,
      "circle-emissive-strength": 0.18,
    },
  };

  const clusterCountLayer: AnyLayer = {
    id: PLACE_CLUSTER_COUNT_LAYER_ID,
    type: "symbol",
    source: PLACE_SOURCE_ID,
    slot: "top",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["DIN Offc Pro Bold", "Arial Unicode MS Bold"],
      "text-size": 13,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "rgba(3, 7, 18, 0.92)",
      "text-emissive-strength": 0.25,
    },
  };

  const clusterHitboxLayer: AnyLayer = {
    id: PLACE_CLUSTER_HITBOX_LAYER_ID,
    type: "circle",
    source: PLACE_SOURCE_ID,
    slot: "top",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#ffffff",
      "circle-radius": ["step", ["get", "point_count"], 31, 4, 37, 8, 44],
      "circle-opacity": 0.01,
    },
  };

  const placeHaloLayer: AnyLayer = {
    id: PLACE_HALO_LAYER_ID,
    type: "circle",
    source: PLACE_SOURCE_ID,
    slot: "top",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": placeColorExpression(),
      "circle-radius": [
        "case",
        ["boolean", ["get", "selected"], false],
        24,
        18,
      ],
      "circle-opacity": [
        "case",
        ["boolean", ["get", "selected"], false],
        0.34,
        0.2,
      ],
      "circle-blur": 0.48,
      "circle-emissive-strength": 0.18,
    },
  };

  const placeDotLayer: AnyLayer = {
    id: PLACE_DOT_LAYER_ID,
    type: "circle",
    source: PLACE_SOURCE_ID,
    slot: "top",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": placeColorExpression(),
      "circle-radius": [
        "case",
        ["boolean", ["get", "selected"], false],
        11,
        8.5,
      ],
      "circle-stroke-color": [
        "case",
        ["boolean", ["get", "selected"], false],
        "rgba(15, 23, 42, 0.9)",
        "rgba(255, 255, 255, 0.96)",
      ],
      "circle-stroke-width": [
        "case",
        ["boolean", ["get", "selected"], false],
        4,
        5,
      ],
      "circle-opacity": 0.98,
      "circle-emissive-strength": 0.24,
    },
  };

  const placeGlyphLayer: AnyLayer = {
    id: PLACE_GLYPH_LAYER_ID,
    type: "symbol",
    source: PLACE_SOURCE_ID,
    slot: "top",
    filter: ["!", ["has", "point_count"]],
    layout: {
      "text-field": ["get", "glyph"],
      "text-font": ["DIN Offc Pro Bold", "Arial Unicode MS Bold"],
      "text-size": 10.5,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "rgba(3, 7, 18, 0.9)",
      "text-emissive-strength": 0.18,
    },
  };

  const placeHitboxLayer: AnyLayer = {
    id: PLACE_HITBOX_LAYER_ID,
    type: "circle",
    source: PLACE_SOURCE_ID,
    slot: "top",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": "#ffffff",
      "circle-radius": 24,
      "circle-opacity": 0.01,
    },
  };

  [
    clusterLayer,
    clusterCountLayer,
    clusterHitboxLayer,
    placeHaloLayer,
    placeDotLayer,
    placeGlyphLayer,
    placeHitboxLayer,
  ].forEach((layer) => {
    if (!map.getLayer(layer.id)) {
      map.addLayer(layer);
    }
  });
}

function updatePlaceSource(map: Map, placeCollection: PlaceFeatureCollection) {
  const source = map.getSource(PLACE_SOURCE_ID);
  if (source && "setData" in source) {
    (source as GeoJSONSource).setData(placeCollection);
  }
}

function buildRouteFeatureCollection(days: TripDay[], selectedDay: DayFilter): RouteFeatureCollection {
  const routeDays =
    selectedDay === "all" ? days : days.filter((day) => day.day === selectedDay);

  return {
    type: "FeatureCollection",
    features: routeDays
      .filter((day) => (day.route?.coordinates.length ?? 0) >= 2)
      .map((day) => ({
        type: "Feature",
        id: `day-${day.day}`,
        properties: {
          day: day.day,
          active: selectedDay !== "all" && day.day === selectedDay,
        },
        geometry: {
          type: "LineString",
          coordinates: day.route?.coordinates ?? [],
        },
      })),
  };
}

function buildPlaceFeatureCollection(
  places: TripPlace[],
  selectedPlaceId: string | null,
): PlaceFeatureCollection {
  return {
    type: "FeatureCollection",
    features: places.flatMap((place) => {
      if (!isValidLngLat(place.lng, place.lat)) {
        return [];
      }

      return [
        {
          type: "Feature",
          id: place.id,
          properties: {
            placeId: place.id,
            name: place.name,
            category: place.category,
            day: place.day,
            glyph: getMarkerGlyph(place.category),
            selected: place.id === selectedPlaceId,
          },
          geometry: {
            type: "Point",
            coordinates: [place.lng, place.lat],
          },
        },
      ];
    }),
  };
}

function registerPlaceInteractions(
  map: Map,
  prefersReducedMotionRef: { current: boolean },
  onSelectPlaceRef: { current: (placeId: string) => void },
) {
  map.on("click", PLACE_HITBOX_LAYER_ID, (event: MapLayerMouseEvent) => {
    const placeId = event.features?.[0]?.properties?.placeId;
    if (typeof placeId !== "string" || placeId.length === 0) {
      return;
    }

    event.preventDefault();
    onSelectPlaceRef.current(placeId);
  });

  map.on("click", PLACE_CLUSTER_HITBOX_LAYER_ID, (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    const clusterId = Number(feature?.properties?.cluster_id);
    const coordinates = feature ? getPointCoordinates(feature) : null;
    const source = map.getSource(PLACE_SOURCE_ID);

    if (
      !Number.isFinite(clusterId) ||
      !coordinates ||
      !source ||
      !("getClusterExpansionZoom" in source)
    ) {
      return;
    }

    event.preventDefault();
    (source as GeoJSONSource).getClusterExpansionZoom(clusterId, (error, zoom) => {
      if (error || zoom == null) {
        return;
      }

      const clusterCamera = {
        center: coordinates,
        zoom: Math.min(zoom + 0.35, 14.6),
        pitch: STANDARD_DAY_PITCH,
        bearing: STANDARD_DAY_BEARING,
      } satisfies Parameters<Map["jumpTo"]>[0];

      if (prefersReducedMotionRef.current) {
        map.jumpTo(clusterCamera);
        return;
      }

      map.easeTo({
        ...clusterCamera,
        duration: 900,
        essential: false,
      });
    });
  });

  [PLACE_HITBOX_LAYER_ID, PLACE_CLUSTER_HITBOX_LAYER_ID].forEach((layerId) => {
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  });
}

function placeColorExpression(): ExpressionSpecification {
  return [
    "case",
    ["boolean", ["get", "selected"], false],
    "#fde68a",
    [
      "match",
      ["get", "category"],
      ["hotel", "transport", "station"],
      "#67e8f9",
      ["restaurant", "market"],
      "#fb923c",
      ["temple", "shrine", "landmark", "attraction"],
      "#fde68a",
      "#facc15",
    ],
  ] as ExpressionSpecification;
}

function getPointCoordinates(feature: { geometry?: GeoJSON.Geometry | null }) {
  if (feature.geometry?.type !== "Point") {
    return null;
  }

  const [lng, lat] = feature.geometry.coordinates;
  return isValidLngLat(lng, lat) ? ([lng, lat] as [number, number]) : null;
}

function isValidLngLat(lng: number, lat: number) {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

function getInitialCameraZoom(initialZoom: number, mode: TripMapMode) {
  if (mode !== "trip") {
    return GLOBE_ZOOM;
  }

  return Math.min(Math.max(initialZoom + 0.85, 11.8), 13.2);
}

function getInitialCameraPitch(mode: TripMapMode) {
  return mode === "trip" ? STANDARD_DAY_PITCH : GLOBE_PITCH;
}

function getInitialCameraBearing(mode: TripMapMode) {
  return mode === "trip" ? STANDARD_DAY_BEARING : GLOBE_BEARING;
}

function getSelectedPlaceZoom(initialZoom: number) {
  return Math.min(Math.max(initialZoom + 4.25, 15.4), 16.4);
}

function getPlacesBounds(places: TripPlace[]) {
  const validPlaces = places.filter((place) => isValidLngLat(place.lng, place.lat));
  if (validPlaces.length === 0) {
    return null;
  }

  const lngs = validPlaces.map((place) => place.lng);
  const lats = validPlaces.map((place) => place.lat);
  let minLng = Math.min(...lngs);
  let maxLng = Math.max(...lngs);
  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);

  if (minLng === maxLng) {
    minLng -= 0.018;
    maxLng += 0.018;
  }

  if (minLat === maxLat) {
    minLat -= 0.018;
    maxLat += 0.018;
  }

  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ] as [[number, number], [number, number]];
}

function getRegionFocusPadding() {
  if (typeof window === "undefined") {
    return 120;
  }

  if (window.innerWidth < 768) {
    return {
      top: 120,
      right: 40,
      bottom: 210,
      left: 40,
    };
  }

  return {
    top: 110,
    right: 440,
    bottom: 210,
    left: 560,
  };
}

function getMarkerGlyph(category: TripPlace["category"]) {
  const glyphByCategory: Partial<Record<TripPlace["category"], string>> = {
    landmark: "L",
    crossing: "X",
    temple: "T",
    shrine: "S",
    market: "M",
    restaurant: "R",
    hotel: "H",
    attraction: "A",
    transport: "T",
    activity: "A",
    station: "S",
  };

  return glyphByCategory[category] ?? "P";
}
