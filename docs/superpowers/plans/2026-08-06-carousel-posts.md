# PLAN — Instagram carousel/photo posts (`/p/<code>`) + graceful capture errors

> Date: 2026-08-06 · Owner: Zhi Hao (arc crosses into Shaun's backend lane — flag at PR) ·
> Board: no card yet (user-directed 2026-08-06; create at Record step) ·
> Branch: `feat/carousel-posts` off **`zh` @ `73a5afd`**, built in the worktree
> `/Users/desmondchyezhihao/Github/astrail-zh` (Rev 2 decision — zh is 93 ahead / 0 behind dev
> and owns newer copies of every frontend file this arc touches; the touched backend files are
> byte-identical on both branches, verified by empty `git diff dev...zh -- backend/scrape …`).
> The MAIN dev checkout has uncommitted `SAVE_LIMIT` work (`rate_limit.py`, `main.py`,
> `test_saved_reels.py`) belonging to another session — do NOT build on it, do NOT touch it.
>
> Research inputs: `scratchpad/apify-carousel-research.md` (Apify actor comparison, cited) and the
> 2026-08-06 Explore seam map (delivered in-conversation; key facts restated inline below — every
> load-bearing claim carries its file:line so the implementer needs no access to that conversation).
> Interview (2026-08-06, all three forks decided by Zhi Hao):
> **(a) `/p/` and `/reel/` of the same shortcode stay two separate cards** — normalized_url remains
> identity; **(b) copy scope = fix only lying strings**, keep "Reels" brand naming; **(c) cover-only
> v1** — the carousel's `displayUrl` is its single cover, no image-list storage.
>
> **Rev 2 (2026-08-06): all findings from `/plan-eng-review` + the Codex outside voice
> (NEEDS-FIXES 6.2/10, no P0) folded** — zh rebase, roll-forward rollback posture, capture-scoped
> error copy, and four test-gap additions. Fold approvals: Zhi Hao, all four groups accepted.

## 0b. Data flow (one picture)

```
paste URL ─▶ TraysScreen ─▶ POST /saved-reels ─▶ normalize_reel_url ──┬─ ok ─▶ RPC upsert (unchanged)
                 ▲                                (widened: reel|p|tv) └─ ValueError ─▶ 422 validation_error
                 │                                                                        │
                 └── friendly copy ◀── api.ts capture-scoped code/status map ◀── {"error":{code,message}}
organize job ─▶ scrape_reel(normalized_url) ─▶ url_kind() ─┬─ "reel" ─▶ apify~instagram-reel-scraper
                                                           └─ "post" ─▶ apify~instagram-post-scraper
                                              └─▶ ReelData (all-Optional fields) ─▶ extractor (caption-only, unchanged)
```

## 0. Why this exists, in one paragraph

Astrail ingests only `/reel/` URLs. A user pasting a travel carousel —
`https://www.instagram.com/p/DQwdZ8ZCWZx/` was the real trigger — gets a raw
`Saved Reels request failed: 422` banner, because (1) the backend's single URL choke point
`backend/scrape/reel_url.py:8` (`^/reels?/<code>`) rejects `/p/`, and (2) the frontend flattens every
non-409 error into `` `Saved Reels request failed: ${response.status}` ``
(`frontend/lib/reels/api.ts:27`, rendered verbatim by `TraysScreen.tsx:119`). Carousel posts are a
major share of Instagram travel content and their captions carry exactly the itinerary text the
extractor feeds on — the extractor is already caption-only
(`backend/genagents/place_extractor.py:199-207` reads `location_name` + `caption`, never
`transcript`), so accepting carousels is an ingestion change, not an extraction change. Worse, the
trip-create client regex **already** accepts `p|tv` (`frontend/lib/trip/parse-inspiration.ts:32`)
and marks them `valid`, shipping URLs the backend then 422s — a live frontend/backend contract
mismatch this arc closes.

## 1. What the research established (all cited in `scratchpad/apify-carousel-research.md`)

- `apify~instagram-reel-scraper` documents its `username` input as "direct **reel** URLs" only; `/p/`
  support is neither confirmed nor denied. We do not bet on undocumented behavior.
- **Decision: URL-kind routing.** Reels keep `apify~instagram-reel-scraper` (only actor with a
  documented `transcript` field — guardrail #10 alignment). `/p/` posts go to
  **`apify~instagram-post-scraper`**: same `{"username": [<url>], "resultsLimit": 1}` input shape,
  same generic `run-sync-get-dataset-items` endpoint (300s sync ceiling; our 120s timeout fits),
  documented output `type` ("Image"/"Video"/"Sidecar"), `childPosts`, `images`, `displayUrl`,
  `caption`, `shortCode`, `ownerUsername`. Its README itself redirects reel scraping to the
  reel-scraper — Apify confirms the split.
- Pricing is a non-factor: all candidates ~$2.30–2.70/1k results, pay-per-result.
- **Open gap:** `locationName` is NOT documented in post-scraper output for direct-URL scrapes.
  The plan treats it as optional everywhere (it already is: `map_item_to_reeldata` uses `.get`,
  `ReelData.location_name` is Optional, the extractor tolerates None). Verified live in T6.
- Fallback actor if the T6 probe shows post-scraper is thin: general `apify~instagram-scraper` with
  `{"directUrls": [url], "resultsType": "posts"}` — same price tier, heavier surface.

## 2. What the seam map established (why this plan is smaller than it looks)

- **One choke point.** Every backend path — capture (`saved_reels.py:9`), trip-gen cache
  (`pipeline/cache.py:29-85`), CLI (`capture.py:162`), manual paste (`scrape/manual_input.py:38`),
  Telegram ingest (`telegram_ingest/reel_filter.py:219`) — funnels through
  `scrape/reel_url.py`. Widening that regex is the load-bearing change; cache and Telegram accept
  posts *for free* once it lands.
- **No DB migration.** Neither `reel_cache` nor `saved_reels` has any CHECK constraining URL shape
  (verified absent in `supabase/migrations/20260701162954_global_knowledge_foundation.sql:3-16` and
  `20260718120000_saved_reels_foundation.sql:1-25`); `capture_saved_reel` RPC takes a pre-normalized
  string. Cover-only v1 adds **zero columns** ⇒ no migration, no `assert_schema.py` update, no
  Pydantic/TS parity additions (guardrail #4 satisfied by *not changing schema at all*).
- **No extraction change.** `place_extractor.py` is text-only and its injection guardrail
  (`reject_reel_prompt_injection`, `:251`) is medium-agnostic. `transcript` is captured but never
  consumed on any live path (`include_transcript` is never True outside the `capture.py` CLI flag) —
  so posts having no transcript changes nothing in practice.
- **Organize layer is ID-keyed** (`organize_jobs`/`organize_job_items`/RPC — zero URL-shape logic).
- Storage cover keys derive from `short_code_of` (`pipeline/cache.py:19-26`) — works for posts; a
  `/p/`+`/reel/` same-shortcode pair sharing one cover object is benign (same content).

## 3. Non-goals (each deferral has a trigger)

| Deferred | Trigger to revisit |
|---|---|
| Shortcode-collapse dedup (`/p/` + `/reel/` same code → one card) | duplicate cards reported in beta feedback |
| Multi-image storage / gallery (`childPosts`, `images` fan-out in `thumbnails.py`) | a gallery UI design exists |
| Stored `media_type` (Apify `type`: Photo/Carousel·N/Video) on cards — Level-2 kind | design wants scraped media type on cards (Level-1 URL-kind badge ships in this arc) |
| `instagram.com/share/…` redirect links (frontend regex accepts them; backend never has) | users hit 422 on share links (feedback/telemetry) |
| Full "Reel"→"post" rename (SQL exception strings `20260720130000_organize_job_error_codes.sql:44-90` + ~25 display strings) | a product rename decision |
| `backfill_reel_covers.py` carousel variant | carousel cards missing covers at scale |
| `location_graph_nodes.node_type` `'carousel'` value | that table gains writers (today: none) |
| TikTok (`source_platform` already allows it) | explicitly out; separate arc |
| `m.instagram.com` host acceptance (trip parser canonicalizes it; capture/Telegram reject — pre-existing mismatch, now visible for posts too; Codex whole-branch P3.1) | users hit 422 pasting mobile-host links (feedback/telemetry) |
| `EvidenceChip` renders 'Reel' for `/p/`-sourced evidence (Codex whole-branch P2.4, fable Minor#3). Corrected rationale: `evidence_json.source_url` ALREADY carries the source URL (persist.py `TripPlaceEvidence`), so a frontend-only `sourceLabel(source_url)` fix suffices — no `EvidenceKind` enum/schema change | design wants per-item source honesty in trip views |

## 4. Tasks

### T1 — Widen the URL choke point (`backend/scrape/reel_url.py`)

The module keeps its name and its two most-called symbols (`normalize_reel_url`, `short_code_of` —
8+ call sites stay untouched); semantics widen to "supported Instagram post URL". `is_reel_url`
**is renamed** — its name would lie once `/p/` passes — to `is_supported_ig_url` (2 production call
sites, both in `manual_input.py`). New discriminator `url_kind` drives actor routing in T2.

```python
"""Instagram post URL normalize + validate (reels + /p/ + /tv/). Pure, offline, stdlib only.

`normalize_reel_url` keeps its historic name for call-site stability; it accepts and
canonicalizes every supported shape:
  /reel/<code>, /reels/<code>  -> https://www.instagram.com/reel/<code>   (kind "reel")
  /p/<code>,    /tv/<code>     -> https://www.instagram.com/p/<code>      (kind "post")
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

_PATH_RE = re.compile(r"^/(reels?|p|tv)/([A-Za-z0-9_-]+)/?$")
_HOSTS = frozenset({"instagram.com", "www.instagram.com"})
_KIND = {"reel": "reel", "reels": "reel", "p": "post", "tv": "post"}


def _match(url: str) -> re.Match[str] | None:
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https"):
        return None
    if (parsed.hostname or "").lower() not in _HOSTS:
        return None
    return _PATH_RE.match(parsed.path)


def is_supported_ig_url(url: str) -> bool:
    """True for an instagram.com /reel/, /reels/, /p/, or /tv/ URL."""
    return _match(url) is not None


def url_kind(url: str) -> str | None:
    """"reel" | "post" | None — drives Apify actor routing (see apify_direct.py)."""
    m = _match(url)
    return _KIND[m.group(1).lower()] if m else None


def short_code_of(url: str) -> str | None:
    """The post short code, or None if `url` is not a supported Instagram URL."""
    m = _match(url)
    return m.group(2) if m else None


def normalize_reel_url(url: str) -> str:
    """Canonical URL (drops query + trailing slash). Raises ValueError if unsupported.

    /tv/ canonicalizes into /p/ — IGTV is retired and Instagram serves those posts at
    /p/<code>; keeping a third canonical shape would leak into dedup keys for nothing.
    """
    m = _match(url)
    if not m:
        raise ValueError(f"not a supported Instagram post URL: {url!r}")
    kind_path = "reel" if _KIND[m.group(1).lower()] == "reel" else "p"
    return f"https://www.instagram.com/{kind_path}/{m.group(2)}"
```

- Update `manual_input.py` (`is_reel_url` → `is_supported_ig_url`: one production invocation at
  `:38` plus the import at `:16`; provenance for a post is equally valid) and any test imports of
  the old name. Grep-verify no other importer: `grep -rn "is_reel_url" backend/ --include="*.py"`.
- **Tests** (`test_reel_url.py`, extend): `/p/DQwdZ8ZCWZx/` → canonical `/p/DQwdZ8ZCWZx`, kind
  `post`; `/tv/<code>` → canonical `/p/<code>`; `/reels/<code>` → `/reel/<code>` (unchanged);
  query+fragment stripped for `/p/…/?img_index=4`; look-alike hosts (`notinstagram.com`,
  `instagram.com.evil.com`) still rejected; `/stories/<user>/<id>` rejected; `url_kind` returns
  None for garbage. Fault-inject per BUILD-LOOP: delete the `_KIND` post entries → the new `/p/`
  tests must redden (proves the widening, not the fixture, is load-bearing).

### T2 — Route the Apify seam by URL kind (`backend/scrape/apify_direct.py`)

`scrape_reel` keeps its name/signature (4 call sites: `organizer.py:681-685`,
`pipeline/runner.py` scrape closure, `capture.py`, and
`backend/scripts/backfill_reel_covers.py` — Codex re-score P3). It routes internally:

```python
ACTOR = "apify~instagram-reel-scraper"
POST_ACTOR = "apify~instagram-post-scraper"

def _endpoint(actor: str) -> str:
    return f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items"
```

In `scrape_reel`: `kind = url_kind(reel_url)`; actor = `POST_ACTOR if kind == "post" else ACTOR`;
build the same `{"username": [reel_url], "resultsLimit": 1}` body; **send `includeTranscript` only
when `include_transcript and kind == "reel"`** (post-scraper doesn't document the flag — don't send
undocumented inputs). POST to `_endpoint(actor)`. Everything downstream is unchanged:
`map_item_to_reeldata` already `.get`s every field, so a post item maps with `transcript=None` and
`location_name` possibly None; the error-item check (`item.get("error")`) is mirrored as-is for
posts (defensive; convention unverified for post-scraper — T6 confirms, and a false-negative here
just surfaces as the existing empty/blocked handling).

- **Tests** (mock `httpx` transport, mirror the existing seam): (1) a `/p/` URL POSTs to a URL
  containing `instagram-post-scraper` — assert on the *request* the mock captured; (2) a `/reel/`
  URL still hits `instagram-reel-scraper` (regression pin); (3) `include_transcript=True` with a
  `/p/` URL sends **no** `includeTranscript` key; with `/reel/` it sends `true` (two assertions,
  distinct outcomes — no disjunctive assertion, per BUILD-LOOP trap #7); (4) a Sidecar-shaped item
  (`type: "Sidecar"`, `caption`, `shortCode`, `displayUrl`, no `transcript`, no `locationName`)
  maps to `ReelData` with `capture_status="CAPTURED"`; (5) post error-item raises
  `ApifyScrapeError`. Fault-inject: hardcode actor back to `ACTOR` → test (1) reddens.

### T3 — Backend surface honesty (`main.py`, `saved_reels.py`, `telegram_ingest`)

- `main.py:416` detail → `"A valid Instagram Reel or post URL is required"`. (Envelope shape
  unchanged: `{"error": {"code": "validation_error", …}}` via `api/errors.py:47-51` — the T4
  frontend mapping keys on `code`, so this copy change is cosmetic server-side.)
- `saved_reels.py` module/function docstrings: "Reel" → "Reel or post" where they describe accepted
  input (identity/RPC semantics unchanged — `p_source_platform` stays `'instagram'`).
- `telegram_ingest/reel_filter.py`: the gate widens automatically via T1 (`:219` calls
  `normalize_reel_url`). Update the module docstring (`:5-16`) and `_PATH_KEYWORDS` comment; add a
  test: a message containing a `/p/` link now yields it in accepted URLs (was: `rejected_shapes`).
  Adjust any existing test asserting `/p/` lands in `rejected_shapes` — that behavior flips by
  design.
- **Tests**: capture endpoint test — **keep the real `capture_saved_reel` function and fake ONLY
  the Supabase client** (monkeypatching the persistence function would make the `/p/` acceptance
  vacuous; Codex P2) — accepts `/p/DQwdZ8ZCWZx/` → 200 with the RPC receiving
  `https://www.instagram.com/p/DQwdZ8ZCWZx`; garbage URL → 422 with the new message; Telegram case
  above. **Cache round-trip test (new, pins the "cache works for free" claim):**
  `cache_places` + `get_cached_places` round-trip with a `/p/` URL against the fake client — this
  test REDDENS if T1's regex widening is reverted (today both silently no-op on `/p/`, the
  silent-wrong class BUILD-LOOP trap hunting exists for). Run the full backend suite:
  `uv run pytest` and the eval gate `uv run pytest evals/ -q` (anchor 6229.0 must hold — nothing
  here imports into evals, assert it anyway).

### T4 — Frontend: graceful capture errors (`frontend/lib/reels/api.ts`, `TraysScreen.tsx`)

Replace the raw-status throw (`api.ts:23-28`; on zh the file additionally imports
`resolveBackendUrl` — leave that line alone) with an envelope-aware mapper. The backend error
contract is `{"error": {"code", "message"}}` for **every** error path — 422 via
`http_exception_handler`, 429 via `_rate_limit_handler` (`code: "rate_limited"`), validation via
`code: "validation_error"` (`api/errors.py:19-28`). **Copy is scoped per endpoint** (Codex P2:
`backendJson` also serves organize/status calls, and "You're saving fast" on an organize 429 is
wrong). Map on `code` first, **then status as a real fallback** (a proxy/CDN error page won't
parse as the envelope), then generic:

```ts
const CAPTURE_ERROR_COPY: Record<string, string> = {
  validation_error: "That doesn't look like an Instagram link we can save. Paste a Reel or post URL like instagram.com/reel/… or instagram.com/p/…",
  rate_limited: "You're saving fast — give it a few seconds and try again.",
}
const GENERIC_ERROR_COPY: Record<string, string> = {
  rate_limited: 'Too many requests — give it a few seconds and try again.',
  unauthorized: 'Your session has expired. Sign in again, then retry.',
}
const STATUS_TO_CODE: Record<number, string> = { 422: 'validation_error', 429: 'rate_limited', 401: 'unauthorized' }
const FALLBACK_ERROR_COPY = 'Something went wrong on our side. Try again in a moment.'

async function backendJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(/* …unchanged… */)
  if (!response.ok) {
    if (response.status === 409 && path === '/saved-reels/organize') {
      throw new Error(ACTIVE_ORGANIZE_CONFLICT_MESSAGE)
    }
    const body = await response.json().catch(() => null)
    const code = (typeof body?.error?.code === 'string' ? body.error.code : null)
      ?? STATUS_TO_CODE[response.status] ?? null
    const copy = (path === '/saved-reels' ? code && CAPTURE_ERROR_COPY[code] : null)
      ?? (code && GENERIC_ERROR_COPY[code]) ?? FALLBACK_ERROR_COPY
    throw new Error(copy)
  }
  return response.json() as Promise<T>
}
```

- `TraysScreen.tsx:119` non-Error fallback `'Could not save that Reel.'` → `'Could not save that
  link.'`; `:252` sr-label → `"Paste a Reel or post link"`; `:258` placeholder → `"Paste an
  Instagram Reel or post link to save it for later…"` (zh line numbers verified identical).
- **Tests** (vitest): capture 422 envelope → capture validation copy; capture 429 → capture rate
  copy; **organize 429 → GENERIC rate copy, not "You're saving fast" (regression, Codex P2)**;
  non-JSON 429 body (HTML error page) → generic rate copy via the STATUS_TO_CODE fallback branch;
  non-JSON unknown status → `FALLBACK_ERROR_COPY`; 409 organize path keeps
  `ACTIVE_ORGANIZE_CONFLICT_MESSAGE` (regression pin). **TraysScreen banner check:** extend the
  existing capture test so a thrown mapped Error's message renders in the `:313` banner (pins the
  user-visible half). Frontend gate: `npm test` + `npx tsc --noEmit` in `frontend/`.
  **Known baseline:** 2 pre-existing SavedReelsFlow test failures were reported on this machine
  (untriaged, non-arc; Codex could not reproduce in read-only mode — EPERM). **Record the actual
  baseline in the zh worktree before T4 starts**; the arc gate is **no new failures** — do not
  silently absorb or "fix" them here without flagging.

### T5 — Frontend: trip-create parser alignment + lying-copy fixes

- `parse-inspiration.ts:37` — align canonicals with the backend: `reels`→`reel` (existing) **and
  `tv`→`p`**: `const type = m[1].toLowerCase().replace(/^reels$/, 'reel').replace(/^tv$/, 'p')`
  (or an explicit small map, matching T1's `_KIND`). `/p/` stays `/p/`. With T1 live, the
  `/p/` URLs this parser already emits stop 422ing — the mismatch closes from both sides.
- `InspirationTray.tsx:34` per-item badge `'Reel'` → `'Reel'`/`'Post'` by URL
  (`normalized_reel_url.includes('/p/')`); `:109` + `:173` copy → "Reel or post link(s)";
  `:116` placeholder → `"https://www.instagram.com/reel/… or /p/…"`. (File identical on zh/dev.)
- `ReelInfoCard.tsx:154` (zh) `"View Reel"` and `CountryTrays.tsx:120` `"Source Reel"` →
  `"View post"` / `"Source post"` when the underlying URL contains `'/p/'` — the helper
  **extends zh's existing `frontend/lib/reels/labels.ts`** (the designated shared-label home,
  consolidated there by a prior review — do NOT create a new file):
  `sourceLabel(url: string): 'Reel' | 'Post'`.
- `LibraryPanel.tsx:208` (zh) empty-state `"…Paste a Reel link on your home…"` → "…Paste a Reel
  or post link…" (lying-string, caught by Codex P3).
- `TripBriefReview.tsx:99` `"Reels (n)"` stays — brand naming per interview decision (b).
- **Kind badge on every saved-card surface (interview addendum, 2026-08-06 — Zhi Hao chose
  Level-1 URL-kind over stored media_type):** render `sourceLabel(card.normalized_url)` as a
  small `Reel`/`Post` badge wherever saved cards render on zh — `LibraryPanel` card rows,
  `ReelInfoCard` header, and the zh-only `ReelBrowseGrid` (`frontend/components/reels/ReelBrowseGrid.tsx`).
  Zero schema change: derived from the URL at render time. Level-2 (`Photo`/`Carousel·N`/`Video`
  from Apify's `type`) stays deferred per §3 with trigger "design wants scraped media type on
  cards".
- **Tests**: parse-inspiration cases (`/tv/x` → `https://www.instagram.com/p/x/`; `/p/x` kept;
  dedup of `/p/x` pasted twice); `sourceLabel` unit test **plus component-wiring tests (Codex P2:
  a helper unit test stays green if a component drops the call)** — extend the existing
  InspirationTray / ReelInfoCard / CountryTrays tests with a `/p/` and a `/reel/` case each,
  asserting the rendered `Post` vs `Reel` badge, `View post` vs `View Reel`, `Source post` vs
  `Source Reel`. Fault-inject: remove one component's `sourceLabel` call → that component's test
  reddens.

### T6 — Live-verify (gated: needs Zhi Hao's explicit go — spends Apify credits)

1. **Probe first** (two credited actor runs, still <$0.01 total — Codex P3 wording fix): scrape
   `https://www.instagram.com/p/DQwdZ8ZCWZx/` via the new post-scraper path
   (`backend/scrape/probe_apify.py` pattern). Record: `type`, `caption` present?, `shortCode`,
   `displayUrl` (CDN host within `thumbnails.py:20` allowlist?), **`locationName` present or
   absent** (closes the research gap); second run: error-item shape on a deliberately-bad URL.
   If the probe shows post-scraper missing `caption`/`displayUrl`, STOP and fall back to
   `apify~instagram-scraper` (`directUrls`) — that swap is contained inside T2.
2. **E2E**: capture that carousel in the app → card renders with cover → organize → places
   extracted with verbatim caption quotes (guardrail #1 holds for carousels).
3. **/qa evidence** (UI flow change ⇒ required by BUILD-LOOP step 7): paste garbage → friendly
   validation copy (not "422"); trigger 429 with **`BURST_LIMIT=2/minute`** in local env (the
   committed `/saved-reels` limiter on both zh and dev is `BURST_LIMIT` — `SAVE_LIMIT` exists
   only in another session's uncommitted work; Codex P2) → friendly rate copy (not "429");
   reel capture regression (unchanged path).

## 5. Guardrail map (CLAUDE.md #1–#12)

| # | Status in this arc |
|---|---|
| 1 evidence-backed places | Unchanged: extractor drops places without verbatim caption quotes; a caption-less carousel yields `location_not_found` — honest failure, verified in T6.2 |
| 2 no raw CoT | untouched |
| 3 partial failure OK | untouched (organize per-item isolation already handles a failed post scrape) |
| 4 schema parity | Satisfied by design: **zero** schema/model/TS field changes |
| 5 auth / 6 owner | capture endpoint auth + RPC ownership unchanged |
| 7 write-through cache | `pipeline/cache.py` now covers posts *for free* (its normalize guard widens with T1); no logic change |
| 10 Apify direct HTTP | post-scraper called via the same direct-HTTP seam; no MCP, no Whisper (posts have no transcript at all) |
| 11 untrusted content | same single ingestion gate (`reel_filter`/extractor guardrails are medium-agnostic) |
| 12 durable jobs | untouched (organize layer ID-keyed) |

Eval-safety: no file under `evals/` or imported by it is touched; `uv run pytest evals/ -q`
(anchor `6229.0`) runs at T3 and again at the final review.

## 6. Risks & rollback

- **Post-scraper field drift** (error-item convention, `locationName`) — all consumed fields are
  Optional; T6.1 probes before the feature is user-visible. Fallback actor swap is contained in T2.
- **`/p/` URL of a video reel** routes to post-scraper (no transcript) — acceptable: transcript is
  consumed by nothing on live paths today (seam-map absence finding).
- **Pre-existing SavedReelsFlow failures** — baseline recorded at T4; arc adds no new failures.
- **Rollback & deployment posture (rewritten per Codex P1 — the original "rows remain valid"
  claim was WRONG):**
  - **Before the arc reaches `dev`** (it lands on `zh`, which is local/unpushed): rollback is a
    trivial revert on zh; nothing is deployed, no data exists.
  - **Once merged to `dev` and deployed** (Render auto-deploys `dev` on checks-pass; Vercel is
    promoted separately): posture is **ROLL-FORWARD, not backend rollback**. Reverting the
    backend after users have saved `/p/` rows leaves poisoned state: `pipeline/cache.py:33`
    no-ops on URLs it can't normalize (cache misses forever), organize/trip retries would hand
    `/p/` URLs to the reels-only actor, and recovered durable jobs containing `/p/` URLs can
    fail. Saved carousel cards would render but never re-organize.
  - **Deploy order at the eventual zh→dev push: backend first.** Wait for Render rollout, then
    smoke a `/p/` **capture AND organize** end-to-end against the deployed backend — verify the
    caption landed, the cache row was written, and the cover re-hosted — before promoting
    Vercel. Capture-only is NOT a sufficient smoke (Codex whole-branch P2.2: `POST
    /saved-reels` only normalizes + persists, so it returns 200 even when `APIFY_TOKEN` is
    broken or the post actor rejects the request; promoting Vercel on a capture-only smoke
    could expose `/p/` ingestion whose every organize fails, after roll-forward-only rows
    already exist). Backend-first is strictly safe because today's deployed frontend already
    emits `/p/` URLs (it just gets 422s). Frontend-first would have the new UI inviting post
    links an old backend rejects.
  - If a backend rollback is ever genuinely forced post-deploy, it must ship with a fast-follow
    that stops `/p/` ingestion at capture (restore the narrow regex) AND handles queued work:
    marking `saved_reels.analysis_status='failed'` alone is NOT enough (Codex re-score P2 —
    neither queued `organize_job_items` nor new organize jobs filter on that status). The
    fast-follow must also fail-out `/p/` items in queued/in-flight organize jobs; per-item
    isolation (guardrail #3) then keeps sibling reel items alive, and new jobs fail the `/p/`
    item at scrape, not the whole job.

## 7. Execution order & gates

All work happens in the **`astrail-zh` worktree** (`/Users/desmondchyezhihao/Github/astrail-zh`),
branch `feat/carousel-posts` off `zh @ 73a5afd`. Record the vitest baseline there before T4.

T1 → T2 → T3 (backend, each: TDD, full `uv run pytest` + eval gate, commit) → T4 → T5 (frontend,
each: vitest + tsc, commit) → final fable whole-branch review + gstack `/review` Codex cross-model
(BUILD-LOOP steps 5+6, both mandatory) → T6 live-verify (user go for credits) → merge into `zh`
(deploy sequencing per §6 applies at the eventual zh→dev push, not at this merge).
One `astrail-developer` per task, `astrail-reviewer` gate per task with fault-injection; ledger in
`.superpowers/sdd/progress.md` (worktree-local).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | outside voice (gpt-5.6-sol, high) | Independent 2nd opinion | 2 | PASS | r1: 6.2 NEEDS-FIXES (1 P1, 4 P2, 5 P3) → all folded → r2: **8.0 PASS** (C8/Cm8/S7/T9/M8, no dim ≤3) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 13 issues total (2 own + Codex's 10 + 1 user-raised base-branch), 0 critical gaps, all folded in Rev 2 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** r1 caught the wrong rollback claim (P1), organize-copy leak, vacuous-test risks, and
  the SAVE_LIMIT/base mismatch; r2 verified every fold against `zh @ 73a5afd` (line refs exact)
  and added 2 residuals (queued-jobs rollback nuance §6, 4th `scrape_reel` call site T2) — both
  folded post-score.
- **CROSS-MODEL:** deploy-order finding was found independently by both reviewers (agreement);
  the error-map "acceptable for v1" claim was Claude-side and Codex refuted it — Codex's fix
  adopted with user approval. No open tension.
- **VERDICT:** ENG + CODEX PASS (8.0/10, gate ≥7.0 met, no dimension ≤3) — ready to implement.

**UNRESOLVED DECISIONS:**
- Whether the `/share/`-links deferral also gets a TODOS.md entry (user pivoted to the kind-badge
  scope question instead of answering; deferral remains plan-table-only until decided).
