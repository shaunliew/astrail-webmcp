# Plan — Durable reel-cover thumbnails (re-host Apify `displayUrl` → Supabase Storage)

> Status: **REVIEWED & AMENDED 2026-07-31** — passed `/plan-eng-review` + Codex outside voice after folding
> all findings (Codex initial: 6.1/10 DO-NOT-IMPLEMENT → all 7 P2 + 4 P3 amended below). Ready for
> `superpowers:subagent-driven-development`.
> Author: planning session 2026-07-31. Feature branch target: a fresh `feat/reel-cover-thumbnails` off `dev`.

## 0. Review amendments folded (2026-07-31)

The first draft was reviewed by an eng pass + a Codex outside voice. Every finding is folded into the tasks
below. Summary so the diff from the original intent is legible:

- **Robustness decision (user):** transient cover failures use **"B + in-run retries"** — persist the raw
  `display_url` in `reel_cache.raw_payload` (durable pointer) **and** retry the download+upload in-run with the
  still-fresh URL (no extra Apify call). See §2.
- **`rehost_cover` made truly non-raising** — client construction moved inside the guarded region; `aclose`
  failures suppressed; `CancelledError` propagates (Codex P2.3).
- **Storage key derived from the VALIDATED normalized URL**, never the unvalidated Apify `short_code`
  (path-traversal fix, Codex P2.5).
- **SSRF closed** — `https`-only + Meta-CDN host allowlist + redirects disabled (Codex P2.2).
- **Real total deadline** via `asyncio.timeout` (httpx read-timeout is per-chunk, not total); the false
  "10s / parallel across reels" claim corrected — writes are sequential per reel (Codex P2.7).
- **Rollback no longer orphans Storage objects** — documented `empty_bucket()` + `delete_bucket()` procedure
  instead of a SQL delete (Codex P2.1).
- **Backfill** derives the same validated key + uses drain-the-first-NULL-page pagination (Codex P2.6).
- **Migration converges a pre-existing private bucket** to `public=true` (Codex P3.3).
- **Test command fixed** (`cd backend && uv run pytest`, no root `pyproject.toml`) (Codex P3.4); added
  dev-DB round-trip + the missing fault-injection cases (Codex P3.1/P3.2).
- **Verified sound by Codex (no change needed):** the load-bearing "omit-preserves-value" upsert semantics
  (read from pinned `postgrest-py` source), and eval-safety (cache.py absent from the offline import graph).

## 1. Problem & why now

The saved-Reels **Library / Trays** UI renders a cover per reel from `saved_reel_cards.thumbnail_url`
(joined from `reel_cache.thumbnail_url`). That column is **always NULL**, so every card falls back to a
neutral placeholder (`folder-gallery.tsx:21`, `card-fan-carousel.tsx:267`). The cover is dropped at three
points and never written:

1. `backend/scrape/apify_direct.py:22-31` `map_item_to_reeldata` reads only caption/locationName/shortCode/transcript.
2. `backend/models/reel.py:12-20` `ReelData` has no cover field, and `extra="ignore"` (line 13) discards `displayUrl`.
3. `backend/pipeline/cache.py:46-54` `cache_places` upsert omits `thumbnail_url`.

The DB column (`supabase/migrations/20260701162954_global_knowledge_foundation.sql:10`) and the full frontend
read path already exist — this is a **wire-it-up**, not a new-column feature.

**Live probe (2026-07-31)** against `apify~instagram-reel-scraper` for reel `DYbmT-SNzVK` confirmed the cover
field is **`displayUrl`** — a JPG of the cover frame (sibling `images` was empty → do not rely on it).
`displayUrl` is a **signed Instagram CDN URL** (`fbcdn.net`, `stp=…&_nc_ht=…`) that **expires in hours–days**,
so storing it raw regresses to blank covers. Hence strategy **B**: re-host the JPG into Supabase Storage at
scrape time and persist a stable public URL.

## 2. Decisions locked in the interview (2026-07-31)

| Decision | Choice | Rationale |
|---|---|---|
| Strategy | **B — re-host to Supabase Storage** | Durable covers for a persistent Library/Trays UI. |
| Bucket access | **Public-read bucket** `reel-covers` (`public=true`) | Covers are frames of already-public reels. Non-expiring URLs, one-line migration, service-role writes bypass Storage RLS → no policy needed. |
| Execution timing | **Inline, best-effort** inside `cache_places` | ≤5 reels/run, small JPGs; the Library covers come from the background organize job (no latency pressure). |
| Existing NULL rows | **Backfill now** (one-time `--confirm` script) | Existing rows' `displayUrl` expired → backfill re-scrapes via Apify. Manual, credit-spending → run only with the user's go. |
| **Transient cover failure** | **B + in-run retries** | Persist raw `display_url` in `raw_payload` (durable pointer, ~100% reliable — it's a string in the same row write) **and** retry the download+upload 2–3× in-run using the still-fresh URL (no extra Apify). First-try success ~99.9%; any residual miss repairs from the saved URL without a re-scrape (within the URL's lifetime). |

## 3. Stack / guardrail conformance

- **In-stack, no new deps.** Supabase Storage is the locked image mechanism (STACK.md:45). `httpx` already a
  dep. `supabase==2.31.0` / `storage3==2.31.0` (`backend/uv.lock:1466-1492`).
- **#3 partial failure:** `rehost_cover` is best-effort and **truly non-raising** (except `CancelledError`); any
  failure ⇒ no cover, the cache write + trip/organize job still succeed.
- **#7 write-through:** cover URL (and the `display_url` pointer) persisted in the same `reel_cache` upsert.
- **#11 untrusted content:** the JPG is downloaded from an external URL → treated as untrusted: **`https`-only +
  Meta-CDN host allowlist + redirects disabled** (SSRF), streamed size cap + total `asyncio.timeout`, stored as
  opaque bytes with a forced `image/jpeg` content-type, never executed. Storage key derived from the
  **validated** normalized URL (no path traversal).
- **#4 schema parity:** `thumbnail_url` already on DB + FE (`frontend/lib/trip/backend-types.ts:160`,
  `frontend/lib/reels/backend-types.ts:66`) — parity met, no FE change. `ReelData.display_url` is internal (never
  crosses the wire). `raw_payload` is an existing DB column not projected to FE.
- **Eval-safety (Codex-verified):** `pipeline/cache.py` is absent from the offline `#16` import graph
  (`run_eval.py:63` → `offline_harness.py:22` imports neither cache nor Supabase; the live runner imports cache
  lazily at `runner.py:248`). The new `pipeline/thumbnails.py` imports only stdlib + httpx at module scope.
  Anchor `mean_intra_day_travel_m = 6229.0` untouched. Gate: `cd backend && uv run pytest evals/ -q`.
- **#12 idempotency:** deterministic Storage path (`<validated-code>.jpg`) + `upsert:true` → re-scrape overwrites
  the same object; a restart re-runs identically.

## 4. Files touched

| File | Change |
|---|---|
| `backend/models/reel.py` | + `display_url: str \| None = None` (internal; raw ephemeral cover URL) |
| `backend/scrape/apify_direct.py` | map `item.get("displayUrl")` → `display_url` |
| `backend/pipeline/thumbnails.py` | **NEW** — non-raising `rehost_cover` (https+host-allowlist, streamed cap, total-deadline, in-run retries) + `_is_safe_cover_url` |
| `backend/pipeline/cache.py` | `cache_places` derives a validated cover key, persists `raw_payload.display_url`, re-hosts, conditionally writes `thumbnail_url`; `rehost` injected |
| `supabase/migrations/20260731120000_reel_cover_bucket.sql` | **NEW** — public `reel-covers` bucket, converges `public=true` |
| `backend/scripts/backfill_reel_covers.py` | **NEW** — one-time `--confirm` backfill (validated key, drain-NULL-page pagination) |
| `backend/scripts/drop_reel_covers_bucket.py` | **NEW** — rollback helper (`empty_bucket` + `delete_bucket`, avoids orphaned objects) |
| `backend/pipeline/test_thumbnails.py` | **NEW** — unit tests incl. all fault-injection + retry + SSRF-reject cases |
| `backend/pipeline/test_cache.py` | + cover-written / omitted-on-failure / validated-key tests + a dev-DB round-trip (gated, no credits) |
| `backend/scrape/test_apify_direct.py` | + assert `displayUrl` → `display_url` mapping (and absent → None) |

**Non-goals (explicit):** no image resize/transform/CDN pipeline; no signed URLs / private bucket; no
background/async re-host self-heal (in-run retries chosen instead); storing the *full* Apify payload in
`raw_payload` (only `display_url`); no frontend change.

## 5. Tasks

> Each task is one `astrail-developer` pass (TDD: red → green → commit). Code blocks are the intended
> implementation — transcribe faithfully.

### Task 1 — `ReelData.display_url`

`backend/models/reel.py` — add the field (keep `extra="ignore"`):

```python
    display_url: str | None = None   # raw, EPHEMERAL Apify cover URL (fbcdn, expires) — re-hosted at cache time, never persisted as-is
```

**Parity check:** `grep -rn "ReelData" frontend/lib` — expect no TS mirror. If one exists, add
`display_url?: string | null`. Record the result in the commit msg.
**Acceptance:** `ReelData(reel_url="x", display_url="http://…").display_url == "http://…"`; omitting ⇒ `None`.

### Task 2 — map `displayUrl` in the scraper

`backend/scrape/apify_direct.py` `map_item_to_reeldata` — add one mapped field:

```python
        display_url=item.get("displayUrl"),   # cover frame (verified live 2026-07-31); `images` was empty — don't use it
```

**Test (`test_apify_direct.py`):** item with `"displayUrl": "https://x/cover.jpg"` ⇒ `rd.display_url` equals it;
item without `displayUrl` ⇒ `display_url is None`.

### Task 3 — `rehost_cover` (new module) — non-raising, SSRF-safe, retrying

`backend/pipeline/thumbnails.py`:

```python
"""Best-effort re-host of a reel cover into public Supabase Storage. Live-only — never on the offline eval
path. Apify's displayUrl is a signed CDN URL that expires in hours/days, so we download it once at scrape time
and re-host to a stable public URL. NEVER raises (except asyncio.CancelledError, which propagates) — every
failure degrades to None (guardrail #3). Untrusted URL: https + Meta-CDN host allowlist, redirects OFF (SSRF);
streamed size cap; a TOTAL asyncio deadline across retries. Transient failures retry in-run using the
still-fresh URL (no extra Apify call)."""
from __future__ import annotations

import asyncio
import sys

import httpx

BUCKET = "reel-covers"
_MAX_BYTES = 8 * 1024 * 1024        # 8 MB cap on untrusted content
_READ_TIMEOUT_S = 5.0               # per-attempt httpx timeout
_TOTAL_DEADLINE_S = 10.0            # hard ceiling ACROSS all retries (real total, not httpx read-timeout)
_MAX_ATTEMPTS = 3
_BACKOFF_S = 0.4
_ALLOWED_HOST_SUFFIXES = (".cdninstagram.com", ".fbcdn.net")


def _is_safe_cover_url(url: str) -> bool:
    """https + Meta-CDN host only — blocks SSRF to loopback / link-local / internal hosts."""
    try:
        parsed = httpx.URL(url)
    except Exception:
        return False
    if parsed.scheme != "https":
        return False
    host = (parsed.host or "").lower()
    return any(host == s.lstrip(".") or host.endswith(s) for s in _ALLOWED_HOST_SUFFIXES)


async def _attempt(client, display_url: str, path: str) -> str | None:
    """One download+upload attempt. Returns the public URL, or None on a DETERMINISTIC reject
    (non-image, oversize, 4xx). Raises on a TRANSIENT failure (network error, 5xx, Storage error)
    so the caller retries. Constructs its own httpx client INSIDE the guarded caller."""
    async with httpx.AsyncClient(timeout=_READ_TIMEOUT_S, follow_redirects=False) as http:
        async with http.stream("GET", display_url) as resp:
            if resp.status_code // 100 == 5:
                resp.raise_for_status()                 # transient → retry
            if resp.status_code // 100 != 2:
                return None                              # 4xx → deterministic, give up
            if not resp.headers.get("content-type", "").startswith("image/"):
                return None                              # deterministic
            buf = bytearray()
            async for chunk in resp.aiter_bytes():
                buf.extend(chunk)
                if len(buf) > _MAX_BYTES:
                    return None                          # deterministic
    if not buf:
        return None
    await client.storage.from_(BUCKET).upload(
        path, bytes(buf), file_options={"upsert": "true", "content-type": "image/jpeg"}
    )
    url = await client.storage.from_(BUCKET).get_public_url(path)
    return (url[:-1] if url and url.endswith("?") else url) or None


async def rehost_cover(client, display_url: str | None, cover_key: str) -> str | None:
    """Re-host the cover at `<cover_key>.jpg` in the public bucket. Return the stable public URL or None.
    Never raises except CancelledError. Retries transient failures in-run (no Apify). Total-deadline bounded."""
    if not display_url or not _is_safe_cover_url(display_url):
        return None
    path = f"{cover_key}.jpg"
    try:
        async with asyncio.timeout(_TOTAL_DEADLINE_S):
            for attempt in range(1, _MAX_ATTEMPTS + 1):
                try:
                    return await _attempt(client, display_url, path)
                except Exception as exc:                 # transient — CancelledError is BaseException, not caught
                    if attempt == _MAX_ATTEMPTS:
                        print(f"  [cover] gave up {cover_key} after {attempt}: {type(exc).__name__}", file=sys.stderr)
                        return None
                    await asyncio.sleep(_BACKOFF_S * attempt)
    except Exception as exc:                              # total-deadline (TimeoutError) or anything unforeseen
        print(f"  [cover] aborted {cover_key}: {type(exc).__name__}", file=sys.stderr)
        return None
    return None
```

> Note (Python ≥3.14 per STACK.md → `asyncio.timeout` available). `CancelledError` is `BaseException` in
> 3.11+, so `except Exception` never swallows it — cancellation propagates cleanly.

**Tests (`test_thumbnails.py`)** — `httpx.MockTransport` for the download + a fake storage client recording
`.storage.from_(bucket).upload/get_public_url`. **Fault-inject** each (remove the guard → test reddens):

1. **Success** → 200 + `image/jpeg` + small body ⇒ upload with `path="<key>.jpg"`, `upsert:"true"`; returns URL.
2. **Non-https / non-allowlisted host** (`http://…`, `https://evil.com/x.jpg`, `https://169.254.169.254/…`) ⇒ `None`, **no GET, no upload**.
3. **4xx** ⇒ `None`, no upload (deterministic, no retry).
4. **Non-image content-type** ⇒ `None`.
5. **Oversize** (> `_MAX_BYTES`) ⇒ `None` (stream aborts).
6. **Empty body** ⇒ `None`.
7. **5xx then 200** ⇒ retried, returns URL (assert 2 attempts).
8. **5xx every attempt** ⇒ `None` after `_MAX_ATTEMPTS` (assert attempt count).
9. **`get_public_url` raises** ⇒ retried then `None`.
10. **client construction / `aclose` raises** ⇒ `None`, does not propagate.
11. **Slow-drip body** (chunks under the read-timeout, total > `_TOTAL_DEADLINE_S`) ⇒ `None` via `asyncio.timeout` (prove the total deadline, not the per-chunk timeout, is what fires).

### Task 4 — write the cover through `cache_places`

`backend/pipeline/cache.py` — validated key + durable pointer + conditional cover; `rehost` injected (keeps the
`.storage`-less `test_cache.py` fake working: existing fixtures have `display_url is None` ⇒ `rehost` never called):

```python
import hashlib
from scrape.reel_url import normalize_reel_url, short_code_of
from pipeline.thumbnails import rehost_cover


def _cover_key(normalized_url: str) -> str:
    """Path-safe Storage key from the VALIDATED normalized URL (never the unvalidated Apify short_code —
    prevents `../bucket` path traversal). Hash fallback if a code can't be extracted."""
    try:
        code = short_code_of(normalized_url)
    except Exception:
        code = None
    return code or hashlib.sha1(normalized_url.encode()).hexdigest()[:16]


async def cache_places(client, url, reel, places, extractor_version, *, rehost=rehost_cover) -> None:
    """...existing docstring... Also persists the raw display_url (repair pointer) and re-hosts the cover
    (best-effort) into public Storage → thumbnail_url. A failed/absent cover OMITS thumbnail_url so a re-cache
    never nulls an existing value (PostgREST updates only supplied columns — Codex-verified)."""
    try:
        key = normalize_reel_url(url)
    except ValueError:
        return

    payload = {
        "normalized_url": key,
        "source_platform": "instagram",
        "caption": getattr(reel, "caption", "") or "",
        "location_name": getattr(reel, "location_name", None),
        "transcript": getattr(reel, "transcript", None),
        "extracted_places": [p.model_dump() for p in places],
        "extractor_version": extractor_version,
    }

    display_url = getattr(reel, "display_url", None)
    if display_url:
        payload["raw_payload"] = {"display_url": display_url}   # durable repair pointer (decision B)
        thumb = await rehost(client, display_url, _cover_key(key))
        if thumb:
            payload["thumbnail_url"] = thumb                    # omit on failure ⇒ preserve prior value

    await client.table(EXTRACTION_CACHE_TABLE).upsert(payload, on_conflict="normalized_url").execute()
    print(f"  [cache] MISS {key} -> cached {len(places)} places (v={extractor_version})", file=sys.stderr)
```

**Tests (`test_cache.py`):**
- **Existing tests unchanged** — confirm they pass (no `display_url` ⇒ no `.storage` call). State this DI property in the module.
- **Cover written:** `reel.display_url` set + `rehost=<fake→"https://…/x.jpg">` ⇒ payload has `thumbnail_url` and `raw_payload={"display_url":…}`; `rehost` called with `cover_key == short_code_of(key)`.
- **Cover omitted on failure:** `rehost=<fake→None>` ⇒ payload has **no** `thumbnail_url` (but still has `raw_payload`).
- **Validated key, not Apify short_code:** set `reel.short_code="../evil"` but a normal URL ⇒ `rehost` called with the URL-derived code, NOT `"../evil"`.
- **Dev-DB round-trip (gated, no credits — `@pytest.mark.integration`, skipped unless `SUPABASE_URL` set):** upsert a row with a non-NULL `thumbnail_url`, then upsert the same `normalized_url` WITHOUT the key, read back ⇒ value preserved. Proves the real PostgREST behavior the fake only mimics (Codex P3.1).

### Task 5 — bucket migration (converging)

`supabase/migrations/20260731120000_reel_cover_bucket.sql` *(timestamp later than the newest existing migration
— `20260720190000_place_name_local.sql` today):*

```sql
-- Durable reel-cover thumbnails: a PUBLIC-READ Storage bucket, written only by the backend service-role key
-- (bypasses Storage RLS → no policy needed). `do update` converges a pre-existing private bucket to public.
insert into storage.buckets (id, name, public)
values ('reel-covers', 'reel-covers', true)
on conflict (id) do update set public = excluded.public;
```

**Rollback:** SQL `delete from storage.objects` leaves **orphaned physical objects** (Supabase warns of this) —
do NOT ship it. Rollback is the documented manual procedure in `backend/scripts/drop_reel_covers_bucket.py`
(`empty_bucket("reel-covers")` then `delete_bucket("reel-covers")`, both in the pinned client). Following house
precedent (`20260720120000` ships no SQL rollback for a pure-additive change), no `rollback/*.sql` is shipped;
the script + this note are the revert path.

**Verification:** `supabase test db` can't exercise Storage bucket creation — apply to **dev**, confirm the
bucket exists and `public=true` (dashboard or `await client.storage.list_buckets()`), then a round-trip
upload/`get_public_url` via a throwaway script. Note in the PR this is dev-verified, not unit-tested.

### Task 6 — backfill script (manual, credit-spending)

`backend/scripts/backfill_reel_covers.py` — one-time, **re-runnable**, `--confirm`-gated:

- **Drain-the-NULL-page pagination** (offset pagination is wrong — updated rows fall out of the `IS NULL` set):
  repeatedly `select … where thumbnail_url is null and source_platform='instagram' limit N` and process the
  batch until a batch returns zero rows.
- Per row: `scrape_reel(url, token=…)` (fresh `displayUrl`) → `rehost_cover(client, display_url, _cover_key(normalized_url))`
  (the **same validated key helper** as Task 4 — never a bare `short_code`, which could be `None` → `None.jpg`
  collisions) → on success `update reel_cache set thumbnail_url=…, raw_payload=… where normalized_url=…`.
- Bounded concurrency (`asyncio.Semaphore(4)`); per-row try/except; print `done/failed/skipped` tally.
- Service-role client + `APIFY_TOKEN`. **Spends Apify credits** → refuses to run without `--confirm`; run only
  with the user's go (BUILD-LOOP step 7). Idempotent: a re-run only touches still-NULL rows.

**Test:** scrape + rehost + db-update seams faked. Assert: a NULL row gets `update` with the URL; a rehost→None
row stays NULL and is counted failed; **a re-run over a fixture containing BOTH a filled and a NULL row skips
the filled one and updates the NULL one** (guards against the vacuous-pass Codex flagged — the fixture must
contain a filled row so "skips filled" is a real assertion).

## 6. Verification (BUILD-LOOP steps 5–7)

- `cd backend && uv run pytest -q` (there is **no root `pyproject.toml`** — must run from `backend/`).
- `cd backend && uv run pytest evals/ -q` — anchor `6229.0` unchanged (eval-safety gate).
- Apply the migration to **dev** Supabase; confirm `reel-covers` exists and `public=true`.
- **Live smoke (needs user go — spends Apify):** scrape one real reel through the organize/cache path against
  dev; confirm the object exists in `reel-covers`, `reel_cache.thumbnail_url` is the public URL, `raw_payload`
  holds the `display_url`, and the URL loads a JPG. UI: gstack `/qa` on Library/Trays — covers render.
- Backfill: dry-run count first; then `--confirm` against dev on the user's go; re-verify a sample.

## 7. Rollback / risk

- **Low blast radius.** If `rehost_cover` always returns None (bucket missing, Storage down), behaviour is
  **identical to today** — NULL thumbnails, placeholders. No regression to trip generation or organize.
- **Migration** is additive; revert = `backend/scripts/drop_reel_covers_bucket.py` (`empty_bucket` then
  `delete_bucket`) — never a raw SQL delete (orphans objects).
- **Latency (corrected):** per-cover work is bounded by a real `asyncio.timeout(_TOTAL_DEADLINE_S=10s)`, but
  cache writes are **sequential per reel** in both paths — worst case (every cover hitting the deadline) adds
  ~10s × reels. Realistically covers succeed in <1s. The covers users see come from the **background organize
  job** (no latency pressure). Deferral trigger below if trip-gen latency is ever measured to hurt.
- **Backfill** is a manual `--confirm` script off the request path; re-runnable.

## 8. Deferrals (each with a trigger)

- **Per-flow retry/deadline budget** — trigger: if the trip-gen critical path's cover latency is *measured* to
  hurt perceived speed, split the budget (tight for trip-gen, generous for organize) or parallelize cache writes.
- **Background self-heal re-host** (the option not taken) — trigger: if in-run retries + the saved `display_url`
  prove insufficient in practice (stuck NULLs observed).
- **Full `raw_payload` capture** (whole Apify item, not just `display_url`) — trigger: a feature that needs more
  raw fields.
- **Image resize / WebP / transform** — trigger: cover payload weight measurably hurts Trays load.
- **Signed URLs / private bucket** — trigger: covers ever become non-public content.

## 9. Resolved review questions

1. **PostgREST "omit-preserves-value" — VERIFIED true** (Codex read pinned `postgrest-py` 2.31.0:
   `request_builder.py:368`, `base_request_builder.py:166`): a singleton upsert sends only its keys with
   `resolution=merge-duplicates`; omitted keys aren't in the conflict update; nullable column ⇒ NULL on first
   insert. A dev-DB round-trip test is still added as belt-and-suspenders (Task 4).
2. **Cover key** — resolved: always derived from the **validated** normalized URL, never the Apify `short_code`.
3. **Backfill over non-null-but-dead objects** — out of scope (all rows are NULL today); the `--confirm`
   re-runnable script + saved `display_url` cover future repair.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open→folded | 4-section pass: 3 findings (SSRF, PostgREST-verify, timeout), all folded |
| Outside Voice | Codex (`gpt-5.6-sol`, high) | Independent 2nd opinion | 1 | issues_found→folded | 6.1/10 DO-NOT-IMPLEMENT initial; 0 P1, 7 P2, 4 P3 — all folded into §5 |

- **CODEX:** initial 6.1/10 (Security 4, Idempotency 5, Test rigor 5, Completeness 5). All 7 P2 (rollback-orphans,
  SSRF, non-raising boundary, sticky-NULL cache-hit, unvalidated Storage key, backfill key/pagination, false
  latency bound) + 4 P3 (upsert-test rigor, missing fault-injection, non-converging bucket, wrong test command)
  are amended in the tasks above. Codex independently **verified** the load-bearing upsert-preservation and
  eval-safety claims (no change needed).
- **CROSS-MODEL:** eng pass and Codex agreed on SSRF and the PostgREST-verification gap; Codex additionally
  caught the non-raising boundary, sticky-NULL durability, path-traversal key, and the false latency bound that
  the eng pass under-weighted. No unresolved tension — every finding folded.
- **VERDICT:** ENG + OUTSIDE VOICE CLEARED after amendment — ready to implement via
  `superpowers:subagent-driven-development`.

NO UNRESOLVED DECISIONS
