# What is new for the WebMCP Challenge

Astrail existed before the WebMCP Challenge submission period. This document separates the established product from work built for the challenge so judges can evaluate the WebMCP extension on its own.

## Pre-existing (before 25 Aug 2026)

Before the challenge, Astrail was already a working travel-planning application. The following capabilities are pre-existing and are not claimed as hackathon work:

- An Instagram Reel ingestion and scraping pipeline that accepted Reel URLs and collected caption and source data.
- Place extraction from Reel content, canonical place matching, deduplication, and confidence-backed evidence records.
- Place enrichment used to turn extracted mentions into useful travel stops, including location and supporting travel context.
- Itinerary generation, day grouping, routing, trade-off handling, and generated trip narration.
- The Next.js 15 and React 19 application, including the saved-Reels flow, trip creation flow, trip pages, and supporting UI.
- The Mapbox GL 3D map, trip pins, routes, day views, and the existing visual itinerary workspace.
- The FastAPI generation backend and its job pipeline, recovery behavior, streaming progress, and persistence layer.
- The Supabase schema for users, saved Reels, places, trips, trip days, trip places, evidence, jobs, and related records.
- Supabase authentication, cookie-based sessions, protected routes, ownership rules, and the existing row-level security policies.

These systems are the product foundation that WebMCP now exposes as a shared human-agent workspace. The challenge work did not create Astrail's scraper, planner, map, database, or authentication system.

## Built for the WebMCP Challenge (from 27 Aug 2026)

The challenge extension adds a browser-native tool layer and the first safe itinerary-editing API surface.

### Browser tool layer

The entire `frontend/lib/webmcp/` directory is new challenge work:

- `types.ts` defines the local WebMCP descriptor, JSON Schema, annotation, and size-limit contracts.
- `tools/app-state.ts` implements `get_app_state`, the discoverability tool prompted by user feedback that Astrail was hard to navigate.
- `tools/trips.ts` implements `list_trips`, `get_itinerary`, and `get_place_evidence`.
- `tools/index.ts` assembles global tools separately from trip-page tools and uses live reader functions to avoid stale state.
- `format.ts` renders compact trip and itinerary output with visible map-pin numbers and source provenance.
- `fit.ts` budgets the full serialized tool-result envelope and drops only complete blocks when output must be reduced.
- `resolve.ts` maps a visible pin number or unambiguous place name to the correct trip-place row and refuses ambiguous matches.
- `__tests__/` adds formatter, output-budget, resolver, and tool-contract coverage.

The four implemented tools are read-only:

| Tool | Scope | Purpose |
|---|---|---|
| `get_app_state` | Global | Reports the current page, available user data, valid next steps, and blockers. |
| `list_trips` | Global | Lists the signed-in user's trips with destination, dates, status, and a short identifier. |
| `get_itinerary` | Open trip | Returns the visible trip as a compact day-by-day itinerary using the map's pin numbers. |
| `get_place_evidence` | Open trip | Returns the evidence quote, source Reel URL, and confidence for one stop. |

All four tools declare `readOnlyHint` and `untrustedContentHint`. Instagram captions are third-party input, so any caption-derived string is explicitly marked untrusted.

`frontend/lib/webmcp/__tests__/spec-contract.test.ts` is also new. It makes tool registration requirements executable by checking unique names, schema shape, required parameters, descriptor limits, annotations, output size, and scope separation. The challenge layer added 54 focused frontend tests in total.

The React registration and visibility components are challenge work too. `frontend/components/webmcp/RegisterTools.tsx` calls the `useWebMCP` hook once per tool and lets mount/unmount lifecycle control registration. `frontend/components/webmcp/GlobalTools.tsx` connects the global factories to live route and trip data. `frontend/components/webmcp/WebMcpRegistry.tsx` and `frontend/components/webmcp/WebMcpStatus.tsx` track registration and show users which agent tools are available in the current page.

### Backend edit foundation

The challenge work also adds two authenticated endpoints:

- `PATCH /trips/{trip_id}/places/{trip_place_id}` changes a stop's day or order.
- `DELETE /trips/{trip_id}/places/{trip_place_id}` removes a stop.

Both routes are hidden unless the default-off `WEBMCP_EDITS_ENABLED` flag is enabled. Before a write, the backend checks the authenticated owner, validates the trip/place pair, rejects unfinished trips, and rejects edits while a generation job is running. After a successful mutation, it densely resequences every affected day so map-pin numbering stays stable and hole-free. The implementation is in `backend/main.py` and `backend/api/schemas.py`; `backend/test_webmcp_edits.py` adds 11 network-free guard and mutation tests.

These endpoints are new infrastructure for the planned `move_place` and `remove_place` browser tools. They do not retroactively make the pre-existing Astrail UI editable, and this document does not claim that the planned tools are already complete.

### Challenge commit record

The append-only `docs/webmcp/RUNLOG.md` currently records one pre-repair commit SHA. That commit temporarily combined frontend and backend work because two agents shared one Git index. The run log documents the incident and the successful tests before the history repair.

| Recorded commit | Challenge delivery |
|---|---|
| `2122c85` | Pre-split mixed commit containing the four-tool registry, contract test, and guarded backend trip-place edit endpoints. The code was safe; only the commit boundary and message were misleading. |

This table intentionally uses only the SHA recorded in `docs/webmcp/RUNLOG.md`. Once the orchestrator records the repaired split SHAs in that append-only file, this table should be expanded to map each replacement commit to its delivery rather than guessing identifiers.

## Planned challenge work, not yet claimed as complete

The next tools are `save_reels`, `plan_trip_from_reels`, `get_trip_progress`, `show_on_map`, `set_map_mode`, `move_place`, and `remove_place`. They will connect the read-only WebMCP foundation and guarded edit API to the complete conversational workflow. They are listed here to distinguish the roadmap from the work already delivered.
