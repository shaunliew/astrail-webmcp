# Plan — item 1: agent-started generation drives the page

**Status: DRAFT, awaiting cross-vendor review.** See `docs/webmcp/AGENT-FIRST.md` item 1.

## The defect

Both paths stream the same SSE run. Only one is attached to the screen.

```
manual button → SavedReelsFlow: setPhase/setEvents/setTripId/router.push → GenerationScene
agent tool    → GlobalTools:    storeRef.current.start(tripId, …)        → get_trip_progress only
```

`GenerationScene` renders from `SavedReelsFlow.tsx:412` alone (real auth). The WebMCP layer has
zero `router.push`. So an agent-started trip never takes the screen, never lands a pin, never opens.

## The seam that already exists

`WebMcpRegistry` holds `MutableRefObject` slots; the page claims one on mount and nulls it on
unmount; `GlobalTools` calls through it. Three already exist and work:

```
refreshOpenTrip     :122     refreshSavedReels   :123     adoptOrganizeJob    :124
```

`SavedReelsFlow` claims two of them at `:111` and `:137`. This is the idiomatic path — no new
provider, no lifted state, no prop drilling.

## Ownership — Option A was wrong (cross-vendor review, 2026-08-28)

The first draft chose **A: the page owns the stream and forwards events into the WebMCP store**,
on the grounds that it was the smallest change. Codex rejected it, and the reasons hold up:

- **Navigating away orphans the run.** `SavedReelsFlow.tsx:92` cancels its stream on unmount. The
  backend job survives, but the store freezes on its last forwarded snapshot, pending polls time
  out answering a stale "generating", no terminal navigation happens, and returning to `/app` does
  not reconnect. The fallback cannot rescue it — the fallback is chosen only at *start*.
- **`plan_trip_from_reels` is registered globally; the slot would exist only while `/app` renders
  `SavedReelsFlow`.** Starting from `/app/trips`, settings, or an open trip takes the fallback and
  still produces no page takeover. **That does not close the defect this plan exists to close.**
- **`feed(event)` was underspecified.** `bump()` ignores every event while `snap` is null
  (`generation.ts:51`) and only `start()` initializes tripId, clock, seen-set, version and status
  (`:81`). Forwarding alone either drops everything or invents initialization semantics.
- **`GenerationScene` needs the full `StreamEvent[]`, not the store's compressed snapshot** — and
  the store keeps no event history.

## Ownership — the design to build

A **narrow generation controller** in a provider at the `/app` layout. It owns generation state and
the stream; it does **not** own `phase`, trays, selection or inbox — those stay in `SavedReelsFlow`.

| It owns | It does not own |
|---|---|
| exactly one `EventSource` | the reels workflow state |
| the full `StreamEvent[]` history | tray/selection/inbox UI |
| the derived progress snapshot + waiters | anything `SavedReelsFlow` renders today |
| the single active-run lock | |
| terminal navigation, at shell level | |

Required operations — a bare `feed()` is not enough:

```
begin(tripId)      initialize SYNCHRONOUSLY, before the async token fetch
accept(event)      append to history, advance version, wake waiters
reset()            streamGeneration calls onReset on every reconnect, because the
                   backend replays all events (lib/trip/api.ts:265)
fail()             the 5-strike SSE escape hatch -> status unknown
finish(result)     a result whose content carries {error: ...} is a FAILURE, not a
                   success (runner.py:154 -> streaming.py:53; generation.ts:60
                   currently treats every result as success)
cancel(runId)      cancels only the stream belonging to THAT run
```

## Hazards the controller must close

- **Single-flight across both entry points.** `handleGenerate` has no guard
  (`SavedReelsFlow.tsx:339`); a manual click and an agent approval can both create real backend
  runs. Hiding the button on the next render is not a concurrency guard.
- **Reject a second agent start while one is active** — *before* another backend generation is
  created. The tool description says "never call this twice"; nothing enforces it
  (`tools/generation.ts:92`).
- **Run-ID guard on every callback.** An old run's terminal callback can cancel the new run's
  stream (`SavedReelsFlow.tsx:364`) and navigate to the old trip.
- **Synchronous init.** `GlobalTools.openStream` fetches a token before `store.start()`
  (`GlobalTools.tsx:183`); in that gap the tool has returned a `trip_id` but
  `get_trip_progress` reports no trip exists. Token failure must surface, not become an unhandled
  fire-and-forget rejection.
- **Effect dependencies.** Both existing slot effects depend on the whole registry object
  (`SavedReelsFlow.tsx:108`), which changes with tools, activity and confirm state
  (`WebMcpRegistry.tsx:169`) — needless teardown and re-registration. Depend on the stable ref, and
  clear on cleanup only if you still own it.

## A bug this plan must fix to meet its own acceptance criteria

**Pins do not currently land progressively.** `GenerationScene` fetches places when a
places-bearing stage fires — but `dedup` is emitted at `runner.py:332` and `persist_itinerary` is
not called until `:391`. The first fetch finds zero places, and `fetchedRef.current = true`
permanently suppresses every later attempt. Key the fetch to a genuinely post-persistence signal.

## Scope — Codex's call, taken

Option A fits in a day and would be unsafe. The correct narrow controller is **~1.5-2 focused days
plus live testing**. With five days left, picking the smaller wrong owner is a false economy.

Safe one-day cut, in order:

1. one generation controller in the persistent `/app` shell
2. `tripId`, status, and the raw event array
3. initialize synchronously, then fetch the token and open exactly one stream
4. `SavedReelsFlow` subscribes and renders `GenerationScene` from that state
5. both manual and agent starts go through one active-run lock
6. reject a second start while generating
7. terminal success, terminal `{error}`, stream failure and router handoff handled once, behind a
   run-ID guard
8. fix the premature places fetch, so the judged map movement actually happens

**Cut:** browser-reload recovery, resuming historical jobs, simultaneous generations, new
generation UI, lifting organize/tray/inbox state, any second SSE connection, generalized event
infrastructure.

**Minimum credible demonstration:** agent approval creates one run, the tool returns immediately,
the persistent stream drives the visible night `GenerationScene`, a post-persistence event lands
real pins, and the terminal result relights and opens the finished interactive trip map. Anything
less still reads as chat progress beside an unrelated website.

## Tests

Load-bearing:

- agent-started run renders `GenerationScene` **and** keeps rendering it across a route change
- exactly one stream opens, asserted on both branches by actual open count
- `waitForAdvance` started *before* an event is forwarded stays pending until that event
- the tool resolves even when the stream never completes (inject a stream that never ends — do not
  assert wall-clock)
- a terminal result carrying `{error: ...}` leaves status failed, not complete
- an old run's callbacks cannot cancel or navigate a newer run
- a second start is rejected while one is active, before any backend call
- places are fetched only after persistence, and actually reach the map

Also: store initialized before the first forwarded event · immediate `get_trip_progress` after the
tool returns · navigation does not kill progress · token-acquisition failure · reconnect replay ·
manual-vs-agent collision · StrictMode registration cleanup · entitlement refetch and dawn relight.

## Live verification (not optional)

Run `plan_trip_from_reels` end to end in ChatGPT's browser. This path has **never** been exercised
through WebMCP. Tests passing is not evidence the handoff works on the judged surface.

## Separately logged, found during this review

- `get_trip_progress` accepts `trip_id` in its schema and **ignores the argument entirely**
  (`tools/generation.ts:167`), so it cannot recover progress for an abandoned run.
- Agent-side creation errors happen before the page has a trip id, so the page's
  `caughtTrialExhausted` handling never runs; entitlement can go stale. Refetch after a failed
  approved creation.
