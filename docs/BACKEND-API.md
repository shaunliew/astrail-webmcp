# Backend API reference

> Moved out of the repo README on 2026-09-03. It is the FE to backend contract, useful if you are
> working on Astrail and noise if you are evaluating it. The README now covers what the project is,
> how to test it, and how to run it. The full production contract, including the go-live checklist,
> is in [`CONNECTION-CONTRACT.md`](CONNECTION-CONTRACT.md).

## Backend API reference (for the frontend)

Base URL: the Render backend service (set as `NEXT_PUBLIC_BACKEND_URL`; `http://localhost:8000` in local dev).

**Split of responsibilities:**
- **Writes / orchestration / streaming → this backend** (`POST /generate-trip`, `GET /generate-trip/stream/...`).
- **Finished-trip reads (list + itinerary detail) → Supabase-direct under RLS.** There are **no backend `GET /trips` endpoints**, the frontend reads trips straight from Supabase with the user's session (RLS enforces ownership). Use the anon key only; the `service_role` key must never reach the browser.

### Auth
Every non-infra endpoint requires the Supabase session **`access_token`** (a JWKS-verified JWT from `supabase.auth.getSession()`).
- `POST /generate-trip` → header `Authorization: Bearer <access_token>`.
- SSE stream → query param `?token=<access_token>` (EventSource can't set headers; a header is also accepted as fallback).

### Error envelope
**Every** error response (401/404/422/429/500, and framework 404/405) has this exact shape, read `error.message`, not `detail`:
```json
{ "error": { "code": "rate_limited", "message": "..." } }
```
Common `code` values: `unauthorized` (401), `not_found` (404), `validation_error` (422), `rate_limited` (429), `internal_error` (500).

### Rate limits (on `POST /generate-trip`)
- **Burst:** 3 requests/minute per user.
- **Daily:** `DAILY_TRIP_QUOTA` trips/user/day (durable; defaults to 5, set per deployment). A `trial` account is additionally capped at `TRIAL_LIFETIME_LIMIT`, one generation, ever.
- Both return **429** with `code: "rate_limited"`. Distinguish them by the `Retry-After` header:
  - **Burst** 429 carries `Retry-After: <n>` (seconds until the 1-min window resets; 1–60, not a fixed 60) + `X-RateLimit-*`.
  - **Daily-cap** 429 has **no** `Retry-After`; message is `"Daily trip limit reached. Try again tomorrow."`

---

### `POST /generate-trip`, start trip generation
Auth: **required** (Bearer). Idempotent: the same request replays the same `trip_id` instead of creating a duplicate.

**Request body** (`application/json`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `reel_urls` | `string[]` | ✅ | 1–5 Instagram Reel URLs |
| `start_date` | `string` | ✅ | ISO date, e.g. `"2026-08-01"` |
| `end_date` | `string` | ✅ | ISO date, e.g. `"2026-08-05"` |
| `destination_hint` | `string \| null` |, | optional free-text hint (e.g. `"Tokyo"`) |
| `pace` | `string` |, | default `"balanced"`; max 32 chars (unknown values accepted, not 422'd) |
| `preferences` | `string \| null` |, | free-text taste; max 2000 chars |

```json
{
  "reel_urls": ["https://instagram.com/reel/abc", "https://instagram.com/reel/def"],
  "start_date": "2026-08-01",
  "end_date": "2026-08-05",
  "destination_hint": "Tokyo",
  "pace": "relaxed",
  "preferences": "loves ramen, quiet neighborhoods, avoid theme parks"
}
```

**Response** `200`, returns the trip id to stream:
```json
{ "trip_id": "9c1e…" }
```
Then open the SSE stream below with that `trip_id`.

**Multiple reels:** pass 1–5 URLs in `reel_urls`; each is scraped + extracted independently, then places are **deduped and combined into one multi-day itinerary** (day assignment is geo-based). *Verified live: `[DWtlEw5D9zs, demo]` → "Come On" (Itabashi) + "Tokyo Dream Park" (Ariake) on separate days, each with real coords + evidence.* A reel that yields no verifiable place is skipped; if **no** reel yields one, the run ends with an error result (no hallucinated stops, guardrail #1).

**Errors:** `401` (missing/invalid token), `422` (bad body), `429` (burst or daily cap, see above), `500` (`{"error":{"code":"internal_error", ...}}`; quota is auto-refunded on failure).

---

### `GET /generate-trip/stream/{trip_id}`, progress + final itinerary (SSE)
Auth: **required** via `?token=<access_token>`. Owner-checked (`404` if the trip isn't yours).
`Content-Type: text/event-stream`.

Each event is a `data:` line whose JSON has `{ type, stage, msg, content }`:
```
data: {"type":"stage","stage":"scrape","msg":"scraping reels","content":{...}}

: heartbeat

data: {"type":"result","stage":"save","msg":"done","content":"<final itinerary as a JSON STRING>"}

data: [DONE]
```

**Contract (important):**
- Progress events have `type` = a stage name (`scrape`, `extract`, `enrich`, `narrate`, …); their `content` is a JSON object.
- The **terminal** event has `type: "result"` and its **`content` is a JSON string** (parse it again) holding the final itinerary. On timeout the backend still emits a terminal `result` with `content` = `{"error":"generation timed out"}` (as a string).
- The stream **always** ends with a `result` event followed by `data: [DONE]`. Treat `data: [DONE]` as the close signal. Lines starting with `:` are heartbeat comments, ignore them.
- A pre-open failure (bad/missing token, not owner) returns the **error envelope** (JSON), not an SSE stream.

---

### `GET /health`, liveness (no auth)
Render's deploy gate. Always cheap, never touches the DB.
```json
{ "status": "ok" }
```

### `GET /readiness`, deep readiness (no auth)
Confirms Supabase is reachable and reports mem0's **configuration** state (monitoring only, **not** the deploy gate).
- `200` → `{ "ready": true, "mem0": "configured" | "disabled" | "init_failed" | "not_initialized" }`
- `503` → `{ "ready": false, "mem0": … }` (DB unreachable, `mem0` is still reported)

`mem0` is observed, never probed: `configured` means a key is set and the client was built, **not** that mem0 is reachable right now. `disabled` = no key · `init_failed` = key set but construction failed · `not_initialized` = key set, not yet constructed. A mem0 outage never fails readiness (guardrail #3).

### `GET /settings/preferences`, the user's saved mem0 memories (auth)
Read **live** from mem0 for the caller's own user (id comes from the token, you cannot read another user's memory). Rate-limited per user like the other authed routes.
```json
{ "status": "ok",
  "facts": [ { "id": "…", "memory": "User prefers ramen and quiet, walkable days",
               "created_at": "2026-07-07T03:08:44", "source": "mem0" } ] }
```
- `status: "ok"` → mem0 answered. **`facts: []` with `ok` is a legitimate empty memory, not an error**, render "nothing saved yet", not a failure.
- `status: "disabled"` → no `MEM0_API_KEY`; memory is off by configuration.
- `status: "unavailable"` → mem0 errored, timed out, or the client failed to construct. Render "memory unavailable", not "you have no preferences".

Always `200`, a memory outage must not break the settings screen (guardrail #3). Mirrors `SettingsPreferencesResponse` in `frontend/lib/trip/backend-types.ts`.

**These are STORED memories, not a preview of recall.** Generation recalls via a semantic `search(top_k=10)` and only when the user leaves preferences blank, so this list is a superset, differently ordered. Facts are mem0's own prose, deliberately **not** the structured `UserPreferenceFact` shape, because mem0 returns sentences and synthesising `fact_key`/`confidence` would be inventing data.

> `POST /settings/memory/clear` (PRD §18) is **not implemented yet**. Until it ships, a "Clear memory" control has no backend, do not wire one to a mock that reports success.

---

> Full FE↔backend production contract (incl. the go-live checklist for wiring the real client) lives in [`docs/CONNECTION-CONTRACT.md`](docs/CONNECTION-CONTRACT.md). Backend response shapes mirror `frontend/lib/trip/backend-types.ts`.

---

## How generation works (the deployed flow)

`POST /generate-trip` returns a `trip_id` immediately and runs the pipeline as a durable background job; the client watches progress over the SSE stream. Each stage is an SSE `stage` event:

1. **create_trip**, persist the trip + run inputs (recovery replays from here).
2. **scrape**, fetch each Reel's caption + transcript via Apify. Write-through cached in `reel_cache`; a re-run of the same Reel emits `cache_hit` and skips scrape+extract.
3. **extract**, pull candidate places from the caption/transcript (OpenAI). Every place must verify (real `lat`/`lng` + evidence) or it is **dropped, no hallucinated places** (guardrail #1). If nothing verifies, the run ends with an error `result` (`"no verified places after extraction"`) rather than inventing stops.
4. **dedup → narrate (assemble)**, the deterministic spine geo-orders places into day groups + feasibility warnings (e.g. `empty_day` when a day has no stops).
5. **enrich** (best-effort, parallel), weather, transport, restaurants, LLM narration; any one may fail without failing the trip (guardrail #3). **Hotel search is switched off** (`HOTEL_SEARCH_ENABLED = False`, `backend/pipeline/runner.py:58`) since Travala's MCP began returning `401` on every call: the stage is not constructed at all, and its slot instead clears any hotel rows an earlier run left behind, so a trip never shows a place to stay that this run did not find.
6. **save**, terminal `result` event, then `data: [DONE]`.

**SSE `result` vs the DB, important for the frontend:**
- The `result` event's `content` is the **deterministic skeleton**: `days` (with `place_names`), `feasibility_warnings`, and a **fixed placeholder `title` = `"Tokyo (offline pipeline skeleton)"`** (the eval-anchored spine). **Do not render `result.itinerary.title` to users.**
- The **real** narrated `title`/`summary` and the **evidence-backed places** (name, `lat`/`lng`, `evidence_json` with the caption quote + research source) persist to Supabase (`trips`, `places`, `trip_places`); the frontend reads them **Supabase-direct under RLS**.

**Reel content requirement:** extraction reads the Reel's **caption + Apify transcript**. Reels that **name places in the caption** (or carry a 📍 location tag / a transcript) extract cleanly; a generic teaser with no named place and no transcript correctly yields zero places → an error result. *(Verified live: a reel captioned `📍 … Come On, Itabashi, Tokyo` extracted the place with matching coords; a generic "best Tokyo restaurants" teaser with an empty transcript produced none.)*

## Backend smoke tests (`backend/scripts/`)

Each self-loads `backend/.env`. Set `SMOKE_BASE_URL` to target a deployed service; omit it to drive the app in-process.

| Script | Proves | Credit |
|---|---|---|
| `smoke_http.py` | health · readiness · CORS · 401 · burst-429 vs quota-429 (self-provisions a throwaway JWKS user with `SMOKE_PROVISION=1`, then deletes it) | none |
| `smoke_quota_rpc.py` | the daily-quota RPC via the real PostgREST `.rpc()` path (non-destructive, net-zero) | none |
| `smoke_generate.py` | one-shot **real** generation end-to-end (POST → SSE → itinerary + evidence-backed places) | **spends Apify + OpenAI** |

```bash
# HTTP surface against the deployed service (zero-credit):
cd backend && SMOKE_BASE_URL=https://astrail-webmcp-api.onrender.com SMOKE_PROVISION=1 \
  uv run python -m scripts.smoke_http

# One real generation against the deployed service (spends credits):
cd backend && SMOKE_BASE_URL=https://astrail-webmcp-api.onrender.com \
  REELS=https://www.instagram.com/reels/<id>/ uv run python -m scripts.smoke_generate
```
