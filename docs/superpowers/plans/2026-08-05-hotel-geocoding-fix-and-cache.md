# Plan — Hotel geocoding fix (locale-aware) + shared geocode cache

> Status: **Eng + Codex ×5 reviewed (4.2→4.5→3.8→4.8→6.5). v5's 2 plan-blockers folded — both were v4
> fold-errors of mine (an identity-gate OVERCLAIM + a ≤60 km-in-cache REGRESSION), fixed by honesty + a
> one-line contradiction fix, no new design question. The identity gate is GROUNDED in VERIFIED
> Travala/Mapbox fields (`poi_category`=lodging, a field we already fetch & discard); it guarantees *never an
> invented/non-hotel pin* (Guardrail #1's literal bar) and explicitly does NOT guarantee "always the RIGHT
> hotel" — that residual is ZH-approved accept-and-watch. Recommend BUILD next; per-task reviews are the
> right gate for remaining detail.** Owner: backend (Shaun's lane, implemented by the fresh ZH session). Base:
> `zh` worktree (`/Users/desmondchyezhihao/Github/astrail-zh`) — has the hotel-hub feature merged. Memory:
> `[[hotel-hub-map-feature]]`. Interview decisions (2026-08-05): **country-aware routing**, **cache misses
> with TTL**, **feasible-first identity gate (accept + watch the wrong-hotel tail; ship the free
> `poi_category` gate, defer the landmark check)**.

---

## ⏭️ SESSION HANDOFF / PICKUP (read this first)

**Where we are:** the hotel-hub map feature is merged on `zh` but **places 0 hotels for Japan** in
production (Mapbox `types="address"` has zero romaji-JP coverage → toggle disabled). Root cause and
fix are **proven live** this session; the migration is already deployed to remote-dev; a POC proved
the end-to-end map UX (hub pin moves on hotel switch, route-centrality ranks correctly). This plan is
**dual-reviewed (Claude eng 7.0 → Codex 4.2 FAIL → all findings folded)** and is now build-ready.

**What the next session does:** implement this plan **task-by-task** via
`superpowers:subagent-driven-development` (`astrail-developer` implements each task,
`astrail-reviewer` gates each). Do NOT expand scope. Then the final whole-branch pass = **Fable**
(not Opus — BUILD-LOOP) + gstack `/review` Codex, then real `/qa` JP regen, then PR into `zh`.

**One decision to confirm at kickoff (the only cross-model tension):** T2 — schema parity for the
internal `hotel_geocode_cache` table. Folded **feasible-first = NO `backend-types.ts` mirror** (the cache is
backend-only, never read by `getTrip`/the bundle; the helper uses a plain dataclass, not a Pydantic
API model, so Guardrail #4's Pydantic↔TS contract does not attach). Codex wanted strict parity
anyway. Confirm feasible-first or override to strict at kickoff.

**Kickstart prompt** is at the very bottom of this file.

**Do NOT run live geocode probes** while iterating — they bill the Mapbox *permanent* tier ($5/1000).

---

## Goal

Make the hotel-hub map place hotels for **Japan** (currently 0 → the Route/Hotel toggle is disabled),
without breaking markets that already work, and add a **hotel geocode cache** so Mapbox's *permanent*
geocoding cost stays flat as trip volume grows.

## Why (problem, proven live)

- `rank_hotels` geocodes Travala's **romaji street address** with `types="address"`. Mapbox has
  **zero romaji address coverage for Japan** → every Tokyo hotel returns 0 features → all
  `unresolved` → `recommendedHotelId` is `null` → the Hotel toggle is disabled. Japan is the market.
- **Cost:** Mapbox bills the **Permanent Geocoding** tier ($5/1,000, **no free tier**, ~$5/mo block
  minimum — confirmed by a real invoice) because we **store** coordinates. Without a cache the bill
  grows **linearly with trips**. Real reuse (remote-dev, 35 trips): **149 hotel rows → 23 distinct
  (85% reuse)** — so a hotel cache is a large, cheap win. Matrix is effectively free.

## Key facts (verified this session — do not re-litigate)

- **Mapbox indexes Japan POIs in Japanese script.** Querying the hotel's **Japanese name** via
  `forward_geocode(types="poi", language="ja")` returned EXACT coords for 5/5 real Tokyo hotels
  (incl. `ヒルトン東京ベイ` correctly ~13.5 km out in the bay). **[Codex v2 #8]** This reuses
  `geocode/policy.py::query_language` (which sends `language="ja"` for Japanese-script queries) — a
  policy currently exercised only by the **capture CLI** (`capture.py:211`), NOT by live reel
  organization (which uses REVERSE country-verification, no query language). The new hotel path is the
  first *live* caller of that forward+`language=ja` policy.
- **Japan is the oddball.** Live Korea probe: romaji address (`types=address`) and English hotel name
  both geocode exactly; **Hangul** name → 0. So the native-script set is currently **`{JP}`**; Korea +
  Western are romaji-first, no LLM.
- **English/romaji name + `language=ja` is DANGEROUS** — "Imperial Hotel" matched a replica 125 km
  away (caught by the ≤60 km gate); "Hilton Tokyo Bay" matched a **vending machine** at the same coords (the
  60 km gate CANNOT catch a same-location wrong POI — **now caught by the `poi_category`=lodging identity gate,
  decision #2c/v4**, using a field Mapbox already returns and we currently discard). The gate stack (country +
  ≤60 km + poi-category=lodging) is much stronger but still proves *a lodging in the right area*, NOT *this
  hotel* — the residual is **any wrong same-area REAL lodging** (Mapbox wrong-branch on a correct name, OR
  localizer name-slot drift; v5 #1) — ZH-approved as accepted + watched (decision #2), always a real lodging,
  never invented/non-hotel. A model that echoes the English name back must be rejected BEFORE
  geocoding. **[Codex v2 #3]** `query_language(name)=="ja"` is TOO WEAK for this —
  it returns `ja` on a single CJK char, so "Imperial Hotel 東京" passes. The JP gate needs a
  **hotel-specific validator** (NFKC, trimmed/non-empty/max-length, reject control/delimiter syntax and
  Latin-heavy mixed text, **require a substantial Japanese-script ratio**) — see decision #2.
- **Travala gives no coords / no mappable ID** (re-audited byte-level). `location` is a narrative
  naming nearby landmarks + distances — a good LLM disambiguation input. Travala fields are
  **untrusted third-party input** (`hotel.py:41`).
- **The hotel FORWARD-geocode is the only UNCACHED live Mapbox seam** *(corrected — Codex re-review
  2026-08-05)*. There are TWO live Mapbox paths, not one: (a) reel places are **country-verified live**
  via `organizer._ground_and_persist` → `grounding._ground_place` → `geocode/mapbox_reverse.reverse_country`
  (Geocoding v6 **REVERSE**, `permanent:"true"` — the paid storable tier), and this is **ALREADY
  write-through cached** in `geocode_country_cache` (migration `20260720110000`); (b) hotels are
  **FORWARD**-geocoded (name/address → coord) in the hotel path, and that is **NOT** cached.
  `capture.py`'s forward *place*-geocoder is a fixture CLI (not live). So the NEW cache work is
  hotel-forward-only — **not because places skip Mapbox (they don't), but because the place reverse
  seam is already handled.** T2/T3 MIRROR that shipped cache's proven patterns rather than reinvent them.
- **LLM pattern** (mirror `genagents/restaurant.py`): `Agent(..., output_type=<Pydantic>)` +
  `Runner.run(..., max_turns=2)`, `DEFAULT_MODEL="gpt-5.5-2026-04-23"` → `FALLBACK_MODEL="gpt-4o"`,
  injectable `runner`, lazy Agents-SDK import (import-keyless), **never imported by the offline eval**.

## Locked design decisions

1. **Country-aware routing.** `_NATIVE_SCRIPT_COUNTRIES = frozenset({"JP"})` (extensible). JP →
   localize → native-script POI (`types="poi", language="ja"`), skipping the always-failing romaji
   attempt. Else → existing romaji `types="address"` path, unchanged.
2. **LLM localization is a coordinate-gated fallback, with a STRICT script gate AND a post-geocode
   identity gate.** Output is a query hint; the coord comes from Mapbox's real POI. **[v2 #3 / v3 #6 —
   exact script validator]** NFKC; **1–120 code points**; reject control chars and the field delimiters;
   **≥ 2 Japanese (Hira/Kata/CJK) chars AND `japanese/(japanese+latin) ≥ 0.70`** — NOT the leaky
   `query_language(name)=="ja"` ("Imperial Hotel 東京" passes it). Fail → skip → `unresolved`, zero
   Mapbox call. **[v3 #2/#5 + v4 — NEVER pin a wrong hotel (Guardrail #1); grounded in verified
   Travala/Mapbox fields, 2026-08-05] Post-geocode IDENTITY gate.** A hotel is `placed` ONLY if ALL hold:
   (a) country matches; (b) ≤ 60 km from the trip centroid — both already live, always re-run per-trip;
   AND (c) **on the JP `types="poi"` path, Mapbox's own `poi_category` for the returned feature contains a
   lodging-type value** (allowlist `{lodging, hotel, hostel, motel, resort, inn, guesthouse, …}` — the
   exact set tuned from the `/qa` capture, since the full enumeration is unconfirmed; fail-open on an
   *unknown* category value is forbidden — unknown → treat as NOT lodging → `unresolved`). `poi_category`
   is a **free, non-circular, script-independent** signal already in the Search Box response we pay for but
   currently discard — T4/#7 extend the parser to keep `feature_type` + `poi_category` (zero new calls).
   This closes the PROVEN failure the 60 km net can't: **"Hilton Tokyo Bay → vending machine"** (a
   non-lodging POI at the same coords) fails (c) → `unresolved`; **"Imperial Hotel → replica 125 km away"**
   already fails (b). **Fail-safe:** any signal uncertain/absent → `unresolved` (honest "couldn't place"),
   NOT cached as `found` — a false "couldn't place" costs only recall, never a wrong pin. **Non-JP
   `types="address"` path:** Mapbox returns no `poi_category` for an address result, so the gate is (a)+(b)
   only — acceptable because a street-address geocode is itself a precise identity signal, and this path
   already works in production. **Accepted, documented residual (ZH-approved 2026-08-05 — scope clarified
   v5 #1):** the gate proves the result is *a lodging in the right area*, NOT that it is *this specific*
   Travala hotel — Travala gives no coords/brand/type/mappable-ID and Search Box gives no confidence score,
   so **any wrong same-area REAL lodging can survive (a)+(b)+(c)**, via EITHER Mapbox matching a
   correctly-translated name to the wrong branch, OR the localizer producing a *different hotel's* name in a
   slot ("name-slot drift" — the ordinal snap-back + structured output + input guardrail bound this but do NOT
   eliminate it; `poi_category` does NOT catch it, because the wrong hotel is itself a lodging). What the gate
   DOES guarantee: the pin is **ALWAYS a REAL lodging in the right area, never invented or non-hotel** — so
   Guardrail #1's literal bar (no hallucinated / non-hotel places) holds; the *softer* "always the RIGHT
   hotel" does not, and the plan must not claim it does. The heavier `location`-narrative landmark cross-check
   that could catch the wrong-hotel case is **DEFERRED** (extra LLM call + a Guardrail #11 surface +
   `location`'s landmark content is not yet fixture-verified) behind a concrete trigger: **live /qa shows a
   real wrong-hotel pin**. **Tradeoff:** feasible-first — the free structured gate holds Guardrail #1's core
   (never a made-up or non-hotel pin) at ~zero cost; the rare wrong-*hotel* residual is *watched, not chased*.
   The feature degrades gracefully (toggle disables, itinerary still renders).
3. **Untrusted input guarded (Guardrail #11) — SERVER ORDINALS, not model IDs.** **[Codex v2 #6]** Do
   NOT trust the model's returned `hotelId` (an allowlist proves membership, not *pairing* — the model
   could return Hotel A's ID with Hotel B's name). Assign **server-side input ordinals** (0..N), send
   those, require **≤1 output per ordinal**, and snap each result back to the server-side hotel by
   ordinal. Wrap Travala `name`/`address`/`location` as **escaped JSON inside explicit delimiters**,
   length-capped **before** serialization; the Agents-SDK **input guardrail** runs `run_in_parallel=False`
   (match `place_extractor.py:247`). Structured output + the coord gate are backstops.
4. **Cache stores the GEOCODE fact, not the gate decision** (eng E1). `status ∈ ('found','miss')` —
   `found` carries `lat/lng/country_code`, `miss` carries none. **[Codex v2 #5]** the DB CHECK enforces
   `found ⇒ lat/lng/country_code NOT NULL`; `miss ⇒ all NULL`; a cached row is re-validated on read through
   a **strict `CacheRow` model** (v3 #10; malformed → treat as a read-miss). **[v4 #2 — cache-hit identity
   drift] The read ALSO invalidates on `name_fingerprint` mismatch:** the key is `{provider,country,hotelId}`,
   so Travala **ID-reuse or a hotel relocation/rebrand** would otherwise return a stale coord for a now-different
   hotel for up to 365 d. On a hit, if the CURRENT hotel's `name_fingerprint` (name+address+`location` digest)
   ≠ the stored one → treat as a **read-miss** (re-resolve + re-gate), not a hit. `name_fingerprint` is thus a
   read-side guard, not merely audit. (A cached `found` row is by construction already identity-gated —
   country + `poi_category`=lodging held when it was written — so only the trip-specific ≤60 km gate needs to
   re-run per-trip on the cached coord; it is never cached, because proximity is trip-specific.)
5. **Cache HIT skips the whole chain** (eng E2 / Codex #1). Order: read cache by the **hotel-identity
   key (#6)** → **translate only the cache-missed JP hotels** → geocode misses → write. Not
   translate-all-then-cache. **[T4-built clarification] "Translate the misses" is PER-KEY, not one
   batch-per-trip:** translate runs INSIDE the per-key `resolve_cached` single-flight (#8), so K missed JP
   hotels = K single-hotel localizer calls, run CONCURRENTLY via `asyncio.gather` (latency bounded by
   concurrency, not the sum). Batching translate OUTSIDE the lock would reintroduce the cross-trip
   double-bill (v3 #3) — so per-key is required, not a shortcut. (The identity key + read-before-translate
   also means the LLM only ever runs on a hotel's FIRST occurrence — later trips reuse the cached coord, so
   translation non-determinism can't drift a hotel across trips; the 1-element batch also removes cross-hotel
   name-slot drift, leaving only single-hotel name hallucination as the accepted residual.)
6. **[Codex v2 #1 — BLOCKER fold] Cache key is a stable IDENTITY, not the query.** The JP Mapbox query
   is the *translated* name, which does not exist until AFTER the cache read — so the key CANNOT be the
   query. Key by the hotel's stable Travala identity: `STRATEGY_VERSION` + canonical-JSON SHA-256 of
   **`{provider:"travala", country_code, hotelId}`** (NFKC + casefold). **Require a non-null, unique
   `hotelId` to cache at all** (missing/duplicate ID → not cached, resolve live); store a **name/address/
   `location` fingerprint** on the row — used as a **read-side invalidation guard** (decision #4 / v4 #2:
   fingerprint mismatch on a hit → re-resolve) as well as drift audit. **Proximity is a disambiguation HINT,
   not part of the key** — passed through to the geocode call for biasing, **NOT keyed on AND NOT persisted**
   (v3 #9; a hotel's true location is the same regardless of which trip asked → all trips share the entry,
   maximizing reuse). Bump `STRATEGY_VERSION` for algorithm changes.
7. **Infra failure ≠ geocode miss — explicit taxonomy** (v2 #4 + **v3 #7/#8**). Shared exceptions in a
   cycle-free `geocode/errors.py` (`ResolveError`, `CacheError`). Outcomes: **valid-empty Mapbox** or
   **semantically-invalid / unlocalizable** → cacheable **`miss`**; **translator/OpenAI failure,
   guardrail trip, timeout, 4xx/429/5xx, malformed 2xx** → **`ResolveError`**, **NOT cached, NOT a miss**.
   **[v3 #7] A STRICT hotel geocoder is a prerequisite:** today's `forward_geocode` returns `None` for
   BOTH valid-empty and malformed 2xx (test-frozen) — the hotel path needs a strict adapter where only a
   valid `FeatureCollection` with `features=[]` → miss, and malformed JSON/shape/coords → typed error →
   `ResolveError` (capture keeps its lenient behavior). **[v4] The strict adapter also EXTENDS the parser
   to keep two fields Search Box already returns and `parse_forward_response` currently discards —
   `feature_type` and `poi_category` (a list; empty for address-type results)** — so the identity gate
   (decision #2c) can read them. Pure additive parse of a response we already fetch/pay for; add the two
   fields to `GeocodeResult` (a **Pydantic `BaseModel`**, not a dataclass — v5 impl-note; these two fields are
   internal to the geocode seam, NOT part of the trip bundle, so no `backend-types.ts` mirror — the kickoff
   schema-parity decision should say so explicitly) — Search Box has **no** relevance/confidence score to lean
   on, so these structured facts are the only non-circular identity signal available. **[v3 #8] Prefilter unsafe hotels BEFORE
   batching** so one injection-y name can't collapse the whole batch to empty and negative-cache the safe
   ones. `persist_hotels` **preserves prior hotel rows** on any `ResolveError`/`CacheError`; the
   **missing-MAPBOX-token** path is explicitly an infra failure (**preserve rows**, not an all-unresolved
   wipe) — and tested.
8. **Single-flight covering translate+geocode as a UNIT** (Codex #7 + **v3 #3 + v4 #3 — one lock owner**):
   the in-process keyed `asyncio.Lock` is acquired in **exactly one place — inside `resolve_cached` (T3)** —
   which re-reads under the lock and then runs the injected `resolver` callback (translate → JA-validate →
   geocode → identity-gate) so the entire translate+geocode unit executes inside ONE lock hold; two concurrent
   callers of one key pay for **ONE** translate AND one geocode. **T4 does NOT separately claim/acquire the
   key** — `asyncio.Lock` is not reentrant, so a nested acquire under a T4-held claim would DEADLOCK (v4 #3).
   T3's `lookup_many` is the lock-free initial bulk read; the per-key single-flight applies only to the misses
   that then flow through `resolve_cached`. **[v2 #7]** the
   hotel-row REPLACE is lease-fenced (`persist.py:932`) but the cache/geocode is NOT, so cross-instance
   overlap's residual is **duplicate paid BILLING**. **[v3 #11] Enforce the single-instance assumption
   NOW:** pin the web service to `numInstances: 1` in `render.yaml` (currently only the Telegram worker
   is pinned) + add duplicate-call telemetry; a DB claim/lease is MANDATORY before scaling past one instance.
9. **Cache is opt-in via an injected client** — `client=None` → no cache → offline/eval byte-identical.
10. **Feasible-first:** reuse `forward_geocode` + `policy.query_language`; no new geocoder, no
    transliteration library, no JP structured-address parser (deferred with triggers). `rank_hotels`
    stays pure + deterministic (resolution injected).

## Data flow (hotel stage, after this change)

```
persist_hotels
  binds resolve_hotels = geocode/hotel_resolver.resolve_hotels(
        hotels, country_code, city, proximity_lng_lat, *, geocode, translate, cache_client, token)
  rank_hotels(hotels, places, ..., *, resolve_hotels, matrix):
     coords = await resolve_hotels(hotels, proximity=trip_centroid)   # LIST aligned with input order (v3 #4)
     gate each (country match + ≤60km haversine)    # ALWAYS re-run — never cached  (UNCHANGED)
     Matrix + blended pref×centrality + top-3        # UNCHANGED

resolve_hotels (new module):
  key = identity_key({provider:"travala", country, hotelId}) + STRATEGY_VERSION   # v3 #6 — NOT the query
        (no hotelId / duplicate hotelId -> resolve LIVE, do NOT cache)
  lookup_many(keys) -> hits: strict CacheRow re-validate + name_fingerprint match (v4 #2) -> skip translate+geocode
  misses -> resolve_cached(key, resolver=…) OWNS the single-flight lock (v4 #3; T4 does NOT re-acquire).
            resolver() runs the whole unit under ONE lock hold:
    JP:   localize(server ORDINALS, prefilter unsafe #8) -> JA-SCRIPT-RATIO validator (#2)
          -> strict_geocode(name, types=poi, language=ja, country=country_code, proximity)     # country ALWAYS (v3 #1)
    else: strict_geocode(f"{address},{city}", types=address, country=country_code, proximity)  # country ALWAYS (v3 #1)
    IDENTITY GATE (#2c, TRIP-INDEPENDENT ONLY): country + (JP poi path) poi_category CONTAINS lodging  else unconfirmed miss
       # ≤60km is NOT here — it is trip-specific, re-runs per-trip in rank_hotels (never cached, v5 #2)
    write: identity-confirmed found (expires_at=+365d) | valid-empty / UNCONFIRMED miss (expires_at=+14d)
  typed failure (#7): translator / Mapbox-infra / malformed-2xx -> ResolveError (NOT cached)
       -> re-raised before persist's broad except -> persist_hotels PRESERVES prior rows
  return: LIST aligned with INPUT ORDER (v3 #4) — hotelId only gates cache eligibility + the key
```

## Non-goals (v1; each has a trigger)

- **Reel-place FORWARD-geocode cache** — the live place path country-verifies via Mapbox **REVERSE**
  (already cached in `geocode_country_cache`); there is **no live place FORWARD-geocode seam** (that
  path, `capture.py`, is a fixture CLI). Trigger: a confirmed live place path that calls `forward_geocode`.
- Cross-instance single-flight (DB claim/lease). Trigger: measured duplicate paid geocodes across
  Render workers.
- Deterministic transliteration / JP structured-address parsing (research: not viable).
- Property-photo / brand-logo pin; hotel-pin **bed glyph** (separate FE tasks).

---

## Tasks (task-by-task; each independently implementable + reviewable)

### T1 — `genagents/hotel_translate.py`: guarded batched name localizer
- New file mirroring `restaurant.py`: `Agent(name="hotel_name_localizer", model=DEFAULT_MODEL,
  instructions=…, output_type=HotelLocalization)`, injectable `runner`, `gpt-4o` fallback, lazy
  Agents-SDK import, **module docstring: never imported by the offline eval**.
- `async def localize_hotel_names(hotels, country_code, *, runner=None) -> dict[int, str]` keyed by a
  **server-assigned ORDINAL** (0..N), NOT the Travala hotelId (Codex v2 #6). Input per hotel: `name`,
  `address`, `location` (disambiguation), each **length-capped then escaped-JSON inside explicit
  delimiters**. Batched. **[Codex v2 #4] Typed failure:** a runner/OpenAI/infra failure **RAISES
  `ResolveError`** (do NOT swallow to `{}` — a transient outage must never become a cached miss); a
  successful call that simply can't localize a hotel **omits that ordinal** (→ downstream cacheable miss).
- **Guardrail #11 (Codex #4 + v2 #6 / v3 #5,#8):** the Agents-SDK **input guardrail** runs
  `run_in_parallel=False` (match `place_extractor.py:247`); **unsafe hotels are PREFILTERED before the
  batch** so one bad name can't collapse the whole batch to empty (v3 #8). Output is snapped back **by
  ordinal**, **≤1 per ordinal** (out-of-range/duplicate dropped) — this fixes the ID *mapping*, but the
  model could still put Hotel B's *name* in Hotel A's slot; the `poi_category` gate does NOT catch this
  (Hotel B is itself a lodging), so **name correctness is an ACCEPTED + WATCHED residual** (decision #2 —
  bounded by the localizer's accuracy + structured output + the input guardrail, caught only by the deferred
  landmark cross-check), **not** guaranteed by the ordinal or the gate (v5 #1).
- Tests (offline, fake runner): mapping by ordinal; **runner raises → `ResolveError` (NOT `{}`)**;
  empty input → no call; an **instruction-like hotel name/`location`** → guardrail trips / output
  ignored (no injection through); out-of-range / duplicate ordinal → dropped; **adversarial "known
  ordinal, wrong hotel name"** → snapped to the right server-side hotel, not the model's claim.

### T2 — `hotel_geocode_cache` migration + deploy gate  *(schema-parity decision — see handoff)*
- New migration: table `public.hotel_geocode_cache` — named to avoid confusion with `geocode_country_cache`,
  whose patterns it **mirrors**. Columns: `cache_key text primary key` (the IDENTITY key of decision #6:
  `STRATEGY_VERSION` + SHA-256 of `{provider,country,hotelId}` — computable before translation; a version
  bump invalidates en masse, mirroring `verification_version`), `status text not null check (status in
  ('found','miss'))`, `lat double precision`, `lng double precision` (range checks), `country_code text`
  (2-letter), `name_fingerprint text` (digest of Travala name+address+`location`; a **read-side invalidation
  guard** — v4 #2/decision #4 — plus drift audit),
  `created_at timestamptz not null default now()`, `expires_at timestamptz **NOT NULL**`.
  **[Codex v2 #2] Both statuses carry a BOUNDED TTL** — a hotel identity→coord mapping is **mutable**
  (relocation/rebrand/ID-reuse/mis-translation/Mapbox correction), unlike the place cache's *immutable*
  coordinate, so a wrong/stale result must self-correct rather than persist forever: `found` →
  `expires_at = now()+365d` (long — pay ≤ once/year per hotel); `miss` → `now()+14d`. `STRATEGY_VERSION`
  still invalidates ALGORITHM changes; the TTL covers DATA drift. **[Codex v2 #5] CHECK: `status='found'`
  ⇒ `lat/lng/country_code` ALL NOT NULL; `status='miss'` ⇒ `lat/lng/country_code` ALL NULL** (extends the
  coord/status invariant from `20260804120000_hotel_geo_ranking.sql` and ADDS `country_code`). Index on
  `expires_at` (sweep). **RLS enabled, service_role only** (same as `geocode_country_cache`).
- `assert_schema.py` + `test_assert_schema.py`: add `hotel_geocode_cache` + writer-used columns.
- **Schema parity (Guardrail #4) — FEASIBLE-FIRST (deviation from Codex #3, confirm at kickoff):**
  the cache is backend-internal, never read by `getTrip`/the trip bundle. The helper uses a **plain
  dataclass**, not a Pydantic API model → #4's Pydantic↔TS contract does not attach → **no
  `backend-types.ts` mirror**. Documented so review/next-session can override to strict parity.
- Test: migration shape (columns/PK/CHECK/RLS); the coord⇔status CHECK rejects a bad row. No pgTAP
  fence test (no security RPC here).

### T3 — `geocode/cache.py`: cache primitive (key + single-flight + typed failure)
- `identity_key(provider, country_code, hotel_id) -> str`: `STRATEGY_VERSION` + SHA-256 of canonical
  JSON `{provider,country,hotelId}` (NFKC + casefold) — the STABLE identity, computable BEFORE
  translation (decision #6). `hotel_id` MUST be non-null; a missing/duplicate id → caller resolves live,
  no cache. Bumping `STRATEGY_VERSION` invalidates all entries.
- **[v3 #3] `lookup_many(client, keys) -> {key: CacheRow|None}`** — one **lock-free** batched read for T4's
  initial cache pass (decision #8). **[v4 #3] The per-key single-flight lock lives in exactly ONE place —
  inside `resolve_cached` (below).** There is NO separate T4-held `claim(key)`: `asyncio.Lock` is not
  reentrant, so a T4 claim wrapping a `resolve_cached` that re-acquires the same key would DEADLOCK. Tests:
  two concurrent `resolve_cached` of one key serialize on the internal lock (one resolver call); distinct
  keys run concurrently.
- **TTL / invalidation (Codex v2 #2) — BOUNDED, not infinite:** `found` → `hit_ttl_days=365`; `miss` →
  `miss_ttl_days=14`. A hotel identity→coord mapping is MUTABLE (relocation / rebrand / ID-reuse /
  mis-translation / Mapbox correction), so a `found` row must self-correct within a year — it does NOT
  mirror the place cache's no-TTL (that keys on an *immutable* coordinate). `STRATEGY_VERSION` invalidates
  algorithm changes; the TTL covers data drift. See EMDEE note.
- `async def resolve_cached(client, key, resolver, *, expected_fingerprint, hit_ttl_days=365,
  miss_ttl_days=14) -> GeocodeResult | None`: read by key where `expires_at > now()` → **hit** re-validates
  the row via a **strict `CacheRow` model** (status/coord invariants + `country_code ~ '^[A-Z]{2}$'`,
  uppercased — NOT the loose `GeocodeResult`, v3 #10; malformed → read-miss) **AND checks
  `row.name_fingerprint == expected_fingerprint`** (v4 #2 — mismatch, i.e. Travala ID-reuse/relocation, →
  treat as read-miss, re-resolve); a clean hit returns the cached found/miss. **miss** → in-process
  **single-flight** (keyed `asyncio.Lock` + re-read after acquire, Codex #7 — THIS is the sole lock owner,
  v4 #3) → `await resolver()` → upsert **`found` (`expires_at=now()+hit_ttl_days`) | `miss`
  (`expires_at=now()+miss_ttl_days`)**. **The `resolver()` callback performs the WHOLE miss unit — translate →
  JA-validate → strict-geocode → identity-gate (country + `poi_category`=lodging, decision #2c) — so all of it
  runs inside the single lock hold, and it returns `found` ONLY when identity is confirmed (else an unconfirmed
  `miss`).** `client is None` → skip cache, just `await resolver()`. **Read/write asymmetry mirrors
  `grounding._lookup_cached_country` / `_store_cached_country`: a READ failure → log-and-treat-as-MISS
  (fall through); a WRITE failure RAISES a typed `CacheError`** (Guardrail #7 + Codex #6). **[Codex v2 #4]
  The `resolver()` distinguishes typed outcomes — returns a value/None for a genuine found/valid-empty
  (cacheable), but RAISES `ResolveError` on translator / Mapbox-network / malformed-2xx: a `ResolveError`
  is NOT cached and NOT a miss (propagates).**
- Tests: hit skips resolver; **found upserts a +365d expiry, miss a +14d expiry**; cached `miss` → `None`
  without a geocode; two concurrent same-key calls → **exactly one resolver call**; `client=None` →
  resolver always called, no DB; **a DB WRITE failure raises `CacheError`** (a READ failure falls through to a
  miss — v5 impl-note); **a `resolver()` `ResolveError`
  propagates and writes NOTHING** (not cached as a miss); a malformed cached row → treated as a read-miss.

### T4 — `geocode/hotel_resolver.py`: batch, country-aware, cached hotel resolution
- `async def resolve_hotels(hotels, country_code, city, proximity_lng_lat, *, geocode, translate,
  cache_client, ...) -> list[GeocodeResult | None]` **aligned with INPUT ORDER** (v3 #4 — hotelId only
  gates cache eligibility + the key; a dict-by-hotelId can't represent missing/duplicate IDs, and ranking
  is index-based). Per decisions #1–#8:
  1. Per hotel compute `identity_key` (decision #6; no/duplicate hotelId → resolve LIVE, not cached) and a
     `name_fingerprint` (decision #6/#4). `lookup_many` the cache (decision #8); a candidate hit is used only
     if it passes the strict `CacheRow` model (T2/#10) **AND `name_fingerprint` matches** (v4 #2) — else it's
     a miss. **Prefilter unsafe hotels** (v3 #8) before batching the misses.
  2. Each miss resolves via **`resolve_cached(key, resolver=…, expected_fingerprint=…)`, which owns the
     single-flight** (v4 #3 — T4 does NOT separately claim/acquire). The injected `resolver` closure runs the
     whole unit under the lock: **JP** → `translate(owned misses)` (T1, server ORDINAL) → **JA-script-ratio
     validator** (decision #2; fail → `miss`, zero Mapbox) → `strict_geocode(name, types="poi",
     language="ja", country=country_code, proximity_lng_lat=…)`.
  3. **Non-JP** (inside the same `resolver`) → `strict_geocode(f"{address}, {city}", types="address",
     country=country_code, proximity_lng_lat=…)`. **[v3 #1] `country=country_code` is ALWAYS passed** —
     `forward_geocode` defaults to `jp`, so omitting it mis-geocodes every non-JP hotel.
  4. **IDENTITY GATE (decision #2c / v3 #2,#5 / v4):** the `resolver` returns `found` ONLY if country matches
     AND — on the JP `types="poi"` path — the returned feature's **`poi_category` contains a lodging value**
     (the parser now keeps `feature_type`+`poi_category`, #7; unknown/absent category → NOT lodging → miss);
     else it returns an unconfirmed **`miss`** (→ `unresolved`, NOT cached as `found`). Non-JP address results
     carry no `poi_category` → country-only here (the trip-specific ≤60 km gate re-runs later in `rank_hotels`),
     accept the documented residual. `resolve_cached` then upserts `found` (+365 d) / `miss` (+14 d).
  5. Return the input-ordered list. **A typed `ResolveError`/`CacheError` PROPAGATES** (never coerced to a
     miss). Proximity is passed to geocode for disambiguation only — NOT keyed on, NOT persisted (v3 #9).
- Pure w.r.t. IO (geocode/translate/cache_client injected). Import-keyless.
- Tests: JP hit skips translate+geocode; **a `name_fingerprint` mismatch on a hit → re-resolves, not a stale
  hit** (v4 #2); JP miss → translate → ja-validated → **`poi_category`=lodging confirmed → `found`**;
  **English/mixed localization fails the validator → 0 Mapbox, `miss`**; **identity-gate FAILURE — a returned
  feature whose `poi_category` is non-lodging (the "vending machine" case) or absent → `unresolved`, NOT cached
  as found** (v4 #1 / v3 #2 — the non-lodging case; the name-swap #5 is the ACCEPTED residual, deliberately
  NOT caught here — see decision #2); **non-JP passes `country=country_code`** (KR/US kwargs asserted, v3 #1);
  no-hotelId → live, not cached; duplicate hotelId → both resolved, neither poisons the other; **translator
  `ResolveError` propagates**; **two concurrent `resolve_hotels` for one key → translator AND geocoder each
  called ONCE, no deadlock** (v3 #3 + v4 #3).

### T5 — Wire into `rank_hotels` + `persist_hotels` (+ preserve-on-failure)
- `hotel_ranking.rank_hotels`: replace the `geocode`-per-hotel step (`:218-242`) with a single
  injected **`resolve_hotels`** batch call; keep the **gate, Matrix, ranking, determinism** untouched.
  New param defaults **`resolve_hotels=None`** (explicit — Codex note 2) so existing callers/tests
  don't break; `None` → a thin default that wraps the current romaji `geocode` path (back-comat).
- `persist._rank_hotels_best_effort` / `persist_hotels`: bind the real `resolve_hotels` (geocode +
  translate + cache_client + token + proximity). **[Codex v2 #4] Preserve prior rows on infra failure:**
  a `CacheError`/`ResolveError` must be **re-raised BEFORE `_rank_hotels_best_effort`'s broad
  `except Exception` (`persist.py:867`)** so `_replace_hotel_rows` never runs — treat like the existing
  Travala-fetch-failure path (keep stale-but-real rows), never a full-unresolved clobber. Only genuine
  per-hotel geocode misses become `unresolved`.
- Deploy gate: the 7 hotel columns already covered; `hotel_geocode_cache` added to `assert_schema` (T2).
- Tests: JP trip → placed via fakes; **JP translator SUCCESS-but-unlocalizable → those hotels `unresolved`
  (a genuine miss), but a translator OR geocoder INFRA failure → `ResolveError` → prior placed rows
  PRESERVED, not wiped** (Codex v2 #4 — test BOTH, not only cache-write, vs a pre-existing row set);
  **[v3 #8] missing MAPBOX token → treated as an INFRA failure → prior rows PRESERVED (NOT an
  all-unresolved wipe)**; non-JP unchanged (every existing `test_hotel_ranking.py` green);
  `resolve_hotels=None` → byte-identical to today.

### T6 — Close-out
- **[v3 #11] Pin the web service `numInstances: 1` in `render.yaml`** (currently only the Telegram worker
  is pinned) so the in-process single-flight the plan relies on actually holds; duplicate-call telemetry
  + a DB claim/lease are the "scale past one instance" trigger.
- Cost-model note (permanent $5/1,000; cache → per-unique-hotel-once; 85% reuse).
- **Eval-safety test (eng E6 + Codex v2 #9):** a **subprocess test** that runs the offline eval with
  credentials ABSENT and asserts `genagents.hotel_translate`, `geocode.cache`, and `geocode.hotel_resolver`
  never enter `sys.modules` (imports stay lazy inside the LIVE `persist_hotels` branch). Note `runner=None`
  selects the REAL runner — so eval-safety rests on NOT-importing, not on `runner=None`. `rank_hotels`
  output byte-identical with `resolve_hotels=None`; offline eval anchor unchanged; determinism intact.
- Full backend suite green; then **real `/qa` regen on a JP trip**: hotels get real JP coords, toggle
  enables, hub pin + spokes render, `hotel_geocode_cache` rows written (`found`/`miss`), a 2nd regen hits
  cache (0 new paid geocodes for repeat hotels).

### Close-out per BUILD-LOOP
- Final whole-branch pass = **`astrail-reviewer` on Fable** (NOT Opus — Codex note 5 / BUILD-LOOP)
  **AND** gstack `/review` (Codex) — run both.
- `/qa` live-verify (above). PR (migration + backend in one), merge/sync `zh`, update `.claude/docs`
  + EMDEE + memory `[[hotel-hub-map-feature]]`.

---

## Risks / flags for review

- **R1 — CORRECTED (Codex re-review, gpt-5.6-sol, 2026-08-05).** The earlier "no live place-Mapbox
  seam" claim was WRONG: reel places ARE live-geocoded via Mapbox **REVERSE** country-verification
  (`grounding._ground_place` → `reverse_country`, `permanent:"true"`). But that seam is **already**
  write-through cached (`geocode_country_cache`, migration `20260720110000`). So the NEW cache is
  correctly hotel-**forward**-only — not because places skip Mapbox, but because the place reverse seam
  is handled. T2/T3 now MIRROR that shipped cache (version-bump invalidation, read-miss/write-raise
  asymmetry, collision-safe key, service-role RLS) instead of reinventing the pattern.
- **R2 — Cross-instance single-flight** deferred (in-process only). **[Codex v2 #7 — rationale
  corrected]** the hotel-row REPLACE is lease-fenced (`persist.py:932`) but the cache/geocode call is
  NOT, so the residual of cross-worker overlap is **duplicate paid BILLING** (translate + geocode) — not
  a harmless double-read, not corruption. Fine at the current effectively-single-instance deployment
  (`rate_limit.py:17`); add **duplicate-call telemetry** and make a **DB claim/lease MANDATORY before
  scaling past one web instance** (rolling-deploy overlap). Trigger: measured cross-worker duplicate paid geocodes.
- **R3 — Schema parity deviation (Codex #3).** Feasible-first: no TS mirror for the internal cache.
  Confirm-or-override at kickoff (handoff block).
- **R4 — LLM cost/latency.** **[corrected after T4]** Per the folded single-flight (#8/v3#3/v4#3), translate
  runs INSIDE the per-key `resolve_cached`, so a cold JP trip with K cache-missed hotels makes **K single-hotel
  localizer calls** (concurrent via `asyncio.gather`, each cached 365 d) — NOT one batch-per-trip. The
  batch-outside alternative would reintroduce the cross-trip double-bill, so per-key is required. Cost delta is
  small (~4.25 hotels/trip avg across 35 real trips; each hotel paid once-per-hotel-ever). Bounded.
- **R5 — Eval anchor.** New modules live-only + injected; `client=None`/`runner=None`/`resolve_hotels
  =None` on the offline path keeps the eval byte-identical. T6 verifies.

## GSTACK REVIEW REPORT

**Runs:** Eng-review (Claude, plan-stage) + Codex cross-model (`codex:codex-rescue`). Both DONE.
**Status:** Codex initial verdict **4.2/10 FAIL** → folded → then re-reviewed v2 + v3 (below).

> ⚠️ **SUPERSEDED where noted (v3 #12 + v4).** Some cells in the table below describe the ORIGINAL contracts
> (e.g. `query_language=="ja"`, query-based cache key, first-wins hotelId, `found` never-expires, a
> hand-waved identity check). The **final contracts** are in **Re-review v2 + v3 + v4** above: IDENTITY cache
> key, 365-day bounded TTL, JA-script-ratio validator + a **`poi_category`=lodging identity gate**,
> `name_fingerprint` read-guard, single-owner single-flight lock, server ordinals, typed `ResolveError`,
> strict geocoder. **Note (v5):** the identity gate proves *a lodging in the right area*, NOT *this* hotel —
> the residual is any wrong same-area real lodging, accept-and-watch. Read the v2/v3/v4/v5 sections as
> authoritative; this table is kept for the audit trail.

| # | Src | Sev | Finding | Fold |
|---|-----|-----|---------|------|
| E1 | eng | P1 | Cache stored gate-level `placed/unresolved`; gate is per-trip → cross-trip-wrong | Decision #4 + T2 (`found/miss` + CHECK) + T5 (gate always re-runs) |
| E2/C1 | both | P1 | Translate-all-then-cache → hits still pay the LLM | Decision #5 + T4 (cache-read → translate misses only) |
| C2 | codex | P1 | JP branch sends model output blindly with `language=ja`; English echo recreates the 125 km / vending-machine path (passes the 60 km gate) | Decision #2 + T4 (`query_language=="ja"` required, else skip→miss; test English→0 Mapbox) |
| C3 | codex | P2 | Omitting `backend-types.ts` violates Guardrail #4 | T2 — **feasible-first deviation** (internal cache, dataclass not Pydantic API model, no mirror); confirm/override at kickoff |
| C4 | codex | P1 | "Data not instructions" ≠ the required input guardrail (#11) | Decision #3 + T1 (Agents-SDK input guardrail + delimiters + length caps + output-ID allowlist + injection test) |
| E4/C5 | both | P2 | Cache key collision-prone; omits `language`/proximity/version | Decision #6 + T3 (versioned canonical-JSON + SHA-256, NFKC/casefold) |
| C6 | codex | P1 | Cache/infra failure silently → `unresolved` → `persist_hotels` replaces the whole set → clobbers good coords | Decision #7 + T3 (typed `CacheError`) + T5 (preserve prior rows on infra failure) |
| C7 | codex | P2 | No miss-suppression → concurrent trips double-bill permanent geocodes | Decision #8 + T3 (in-process single-flight + re-read); cross-instance deferred (R2) |
| C8 | codex | P1 | Place-cache seam doesn't exist (`capture.py` is a fixture CLI) | R1 — task REMOVED; cache is hotel-only; place cache → Non-goal |
| E3 | eng | P2 | `rank_hotels` seam unclear for pure cache+translate ordering | T4 (dedicated `resolve_hotels` batch resolver) + T5 (single injected param) |
| E5/C-n3 | both | P3 | null/duplicate `hotelId` handling undefined | T1 (str-canonical, first-wins, skip-missing + tests) |
| n1 | codex | P3 | T1 "romaji fall-through" vs T2 "skip" inconsistent | T1/T2/T5 — one honest `unresolved` behavior |
| n2 | codex | P3 | `resolve_hotels` must default explicitly to `None` | T5 (explicit default; back-compat test) |
| n5 | codex | P3 | Final reviewer was Opus; BUILD-LOOP requires **Fable** | Close-out — Fable |

### Re-review (Codex `gpt-5.6-sol`, xhigh, 2026-08-05) — 5 folds

A third high-effort pass caught a factual discrepancy the earlier reviews missed, plus a reuse win:
- **R1 premise was wrong:** there IS a live place→Mapbox seam (`grounding._ground_place` → `reverse_country`, `permanent:true`) — the plan's "no live place-Mapbox seam" claim was false. But it's **already** write-through cached (`geocode_country_cache`, `20260720110000`), so the hotel-forward-only conclusion survives. **FOLDED:** Key Fact #5 + R1 + Non-goals corrected.
- **Reinvention:** T3 was re-deriving write-through + versioned key + read-miss/write-raise asymmetry + collision-safe key — all shipped in `grounding.py`/`geocode_country_cache`. **FOLDED:** T2/T3 now MIRROR that precedent; table renamed `geocode_cache`→`hotel_geocode_cache` to disambiguate.
- **TTL:** the shipped precedent is *"invalidation is a version bump, NOT a TTL."* **FOLDED:** `found` now NEVER expires (version-bump invalidation via `STRATEGY_VERSION`); `miss` keeps a 14-day TTL (justified divergence — a hotel miss can become a find). Cheaper than the interim 365-day TTL and consistent with the codebase.
- Fresh full re-review (`gpt-5.6-sol`, reasoning=high) queued after these folds.

### Re-review v2 (Codex `gpt-5.6-sol`, high, 2026-08-05) — BLOCK 4.5/10 → 9 findings FOLDED

Verified the v1 folds are correct, then found a genuine BLOCKER + 8 more the first dual-review missed:
- **#1 BLOCKER — cache-key contradiction:** can't read-before-translate AND key by the *translated* query; proximity omitted. **FOLDED:** key by the stable `{provider,country,hotelId}` IDENTITY (decision #6, T3 `identity_key`, T4); proximity passed-not-keyed + stored for audit; require non-null/unique hotelId to cache.
- **#2 — `found` never-expire is unsafe:** a hotel identity→coord mapping is MUTABLE (unlike the place cache's *immutable* coord), so a wrong result would be permanent. **FOLDED:** `found` → bounded **365-day** TTL (T2/T3); `STRATEGY_VERSION` now for algorithm changes only.
- **#3 — `query_language=="ja"` is leaky** ("Imperial Hotel 東京" passes). **FOLDED:** a Japanese-script-RATIO validator (decision #2); dropped the "airtight" claim.
- **#4 — translator outage negative-cached / clobbers rows.** **FOLDED:** typed `ResolveError` (translator/Mapbox-infra) is never cached and is re-raised before persist's broad catch (decision #7; T1/T3/T4/T5).
- **#5 — CHECK omitted `country_code`.** **FOLDED** (T2 CHECK now covers it + `GeocodeResult` re-validation on read).
- **#6 — ID allowlist proves membership, not pairing** (name↔ID swap). **FOLDED:** server ORDINALS, ≤1/ordinal, snap-back (decision #3, T1).
- **#7 — R2 rationale wrong** (write fenced ≠ geocode fenced). **FOLDED:** residual = duplicate BILLING; telemetry + DB-lease-before-multi-instance (R2, decision #8).
- **#8 / #9 — Key Fact "`language=ja` live" wrong; eval-safety not a testable contract.** **FOLDED** (Key Fact corrected to "capture CLI only; hotel path is the first live caller"; subprocess `sys.modules` test, T6).
- Fresh full re-review (`gpt-5.6-sol`, high) queued after these v2 folds.

### Re-review v3 (Codex `gpt-5.6-sol`, high, 2026-08-05) — BLOCK 3.8/10 → 12 findings FOLDED

v3 verified the v2 folds and drilled into implementation contracts. All folded:
- **#1 (real bug my fold introduced)** — the geocode calls dropped `country`, defaulting non-JP to `jp`. **FOLDED:** `country=country_code` ALWAYS passed (T4/data-flow), KR/US kwarg tests.
- **#2/#5 — a wrong hotel could still be pinned** (proximity-poison / batch name-swap). **[ZH: never show wrong info — Guardrail #1] FOLDED (but SUPERSEDED by v4/v5 — this v3 description was under-specified):** the v3 fold proposed a hand-waved "confirm the POI is that Travala hotel via name/addr + `location` landmarks / zero wrong pins". v4 grounded it to `poi_category`=lodging and v5 corrected the claim: the gate proves *a lodging in the right area*, NOT *this* hotel, so it is NOT "zero wrong pins" — see the v4/v5 sections + decision #2c for the authoritative contract.
- **#3 — translate ran outside the single-flight** (double LLM bill). **FOLDED:** the keyed claim wraps translate+geocode as a unit; `lookup_many` bulk read (decision #8, T3/T4).
- **#4 — return type couldn't hold missing/dup hotelId.** **FOLDED:** input-ordinal-aligned list (T4).
- **#6 — validator un-implementable.** **FOLDED:** exact thresholds (NFKC, 1–120 cp, ≥2 JA chars, JA/(JA+Latin) ≥ 0.70) (decision #2).
- **#7 — strict geocoder not a task.** **FOLDED:** a strict adapter (valid-empty→miss, malformed→`ResolveError`) + `geocode/errors.py` (decision #7).
- **#8 — one bad name nukes the batch; missing-token clobbers rows.** **FOLDED:** prefilter unsafe hotels; missing-token = infra-failure→preserve rows (decisions #7/#8, T1/T5).
- **#10 — read re-validated by loose `GeocodeResult`.** **FOLDED:** strict `CacheRow` model (T3).
- **#11 — single-instance not enforced.** **FOLDED:** pin web `numInstances:1` + telemetry (decision #8, T6).
- **#9 — proximity "stored for audit" vs no column.** **FOLDED:** proximity passed-not-persisted (T4).
- **#12 — stale review cells.** **FOLDED:** original findings table + v1/v2 notes flagged SUPERSEDED below.

### Re-review v4 (Codex `gpt-5.6-sol`, high, 2026-08-05) — BLOCK 4.8/10 → 4 PLAN-BLOCKERS + 4 impl-details

v4 verified the 12 v3 folds (8 PASS) and — asked to separate true plan-blockers from build-loop
implementation-detail — surfaced that the v3 **identity gate was under-specified** (I had hand-waved
"confirm via name/addr + location landmarks"; Codex showed name-matching is CIRCULAR for the by-name JP
search, `location` is untrusted text with no coordinates, and `GeocodeResult` carried no independent
evidence). **Grounded by a fresh field audit** (`astrail-researcher`, read-only, 2026-08-05): Travala gives
name/star/address/`location`/price and **no coords/type/brand**; Mapbox **Search Box** returns `feature_type`,
**`poi_category`** (e.g. `lodging`), `brand`, `context.*`, `coordinates.accuracy` — all currently DISCARDED by
`parse_forward_response` — and has **NO relevance/confidence score**. All 4 blockers folded:
- **#1 — identity gate not implementable.** **FOLDED (decision #2c, #7, T4); scope corrected v5 #1:** the
  cacheable trip-independent gate = country + (JP `types=poi`) **`poi_category` contains a lodging value** — a
  free, non-circular, script-independent signal; parser extended to keep `feature_type`+`poi_category`. It
  proves the result is *a lodging in the right area*, catching the proven vending-machine case; fail-safe
  (unknown/absent → unresolved). It does **NOT** prove *this specific* hotel (no Travala coord/brand/ID, no
  Mapbox confidence), so **ZH decision: accept + watch** the residual = **any wrong same-area real lodging**
  (Mapbox wrong-branch OR localizer name-slot drift), always real/non-invented; defer the heavier
  `location`-landmark LLM cross-check behind a live-/qa trigger. The ≤60 km check is trip-specific and re-runs
  in `rank_hotels`, never in the cache resolver (v5 #2).
- **#2 — cache-hit skips the gate → identity drift.** **FOLDED (decision #4/#6, T3/T4):** `name_fingerprint`
  becomes a **read-side invalidation guard** — mismatch on a hit (ID-reuse/relocation) → read-miss + re-resolve;
  a cached `found` is identity-gated by construction, so only the per-trip ≤60 km gate re-runs.
- **#3 — single-flight self-deadlocks** (T4 claim + `resolve_cached` both acquire the non-reentrant keyed
  lock). **FOLDED (decision #8, T3/T4):** the lock lives in `resolve_cached` ALONE; the `resolver` closure runs
  translate+geocode+gate under one hold; T4 does not separately claim.
- **#4 — active plan/kickstart still carried contradictory contracts** (return-type comment, proximity
  "stored", `GeocodeResult` re-validation, "accepted wrong-nearby residual"). **FOLDED:** swept data-flow,
  decision #4/#6, key-facts, and the kickstart to match the locked contracts.
- v4's 4 impl-details (strict-adapter wiring, multi-key lock ordering, validator mechanics, cache
  terminology) are left to the per-task build reviews per the plan-is-a-contract framing.

### Re-review v5 (Codex `gpt-5.6-sol`, high, 2026-08-05) — BLOCK 6.5/10 → 2 PLAN-BLOCKERS + 2 impl-details FOLDED

v5 confirmed fingerprint-invalidation and single-flight are fully closed, and verified the field facts
against the code — but caught **two contract errors introduced by the v4 folds themselves**:
- **#1 — the gate proves lodging TYPE, not hotel IDENTITY.** `poi_category=lodging` rejects the vending
  machine but cannot prove the returned lodging is *this* Travala hotel: a localizer name-slot drift (Hotel
  B's name in Hotel A's slot) yields real Hotel B, which passes country+60 km+lodging. **FOLDED (honesty):**
  the accepted residual is widened from "same-chain same-city wrong branch" to **any wrong same-area real
  lodging** (Mapbox wrong-branch OR name-slot drift); every claim that the gate "catches the name-swap #5" is
  removed (decision #2c, T1, T4 test, key-facts, kickstart, v4-note). The gate's real guarantee — *never an
  invented or non-hotel pin* (Guardrail #1's literal bar) — is kept; the softer "always the RIGHT hotel" is
  explicitly disclaimed and watched via the deferred landmark check.
- **#2 — the data-flow still put the ≤60 km check INSIDE the cache resolver** (a v4 regression), which would
  negative-cache a valid hotel that was merely far from one trip's centroid. **FOLDED:** the cacheable
  resolver gate is country + `poi_category` ONLY (trip-independent); ≤60 km moved out to `rank_hotels`
  (trip-specific, never cached) — data-flow + kickstart corrected to match decision #4 / T4.
- Impl-details folded early: `GeocodeResult` is a Pydantic model not a dataclass (schema-parity note added);
  T3's "DB failure raises" qualified to a WRITE failure (reads fall through to a miss).
- **No new DESIGN questions** — both blockers were my own fold errors (an overclaim + a regression), fixed by
  honesty + a one-line contradiction fix, consistent with the ZH "accept + watch the tail" decision. Remaining
  refinement belongs to the per-task `astrail-reviewer` during implementation.

**CROSS-MODEL:** Codex was the decisive pass — E1/E2 overlapped the eng review, but C2 (English-echo
safety hole), C4 (input guardrail), C6 (clobber-on-failure), C7 (double-bill), and C8 (phantom seam)
were gaps the Claude pass missed. One genuine DISAGREEMENT — C3 schema parity — resolved feasible-first
per project policy, flagged for the user to override. No other tension; Codex hardened contracts the
eng pass under-specified.

**VERDICT:** ENG (Claude) + CODEX (cross-model, **×5 rounds**). Codex scores: v1 4.2 → v2 4.5 → v3 3.8 →
v4 4.8 → **v5 6.5**, each round drilling deeper as the higher-level contracts closed (v4/v5 explicitly split
true plan-blockers from build-loop impl-details). v5's 2 plan-blockers were **fold-errors introduced by the
v4 round itself** (an identity-gate overclaim + a ≤60 km-in-cache regression) — now folded by honesty + a
one-line contradiction fix, with **no new design question surfaced**. The identity gate is field-grounded
(`poi_category`=lodging) and honestly scoped: it guarantees *never an invented/non-hotel pin* (Guardrail #1's
literal bar), NOT "always the RIGHT hotel" (a ZH-approved accept-and-watch residual). **BUILD-READY** — per
the plan-is-a-contract framing, remaining implementation-detail belongs to the per-task `astrail-reviewer`
during `superpowers:subagent-driven-development`; a 6th plan review would be the treadmill.

**UNRESOLVED DECISIONS:**
- **C3 / R3 — schema parity for `hotel_geocode_cache`:** folded feasible-first (no `backend-types.ts`
  mirror, internal cache). Confirm feasible-first or override to strict Pydantic+TS parity at kickoff.

---

## KICKSTART PROMPT (paste into the next session)

```
Read .claude/CLAUDE.md and the memory note [[hotel-hub-map-feature]].
Implement the approved, dual-reviewed plan at
docs/superpowers/plans/2026-08-05-hotel-geocoding-fix-and-cache.md
task-by-task via superpowers:subagent-driven-development (astrail-developer implements
each task, astrail-reviewer gates each). Do NOT expand scope.

Base: the zh worktree (/Users/desmondchyezhihao/Github/astrail-zh) — feature already merged there.

FIRST, confirm the ONE open decision (plan §UNRESOLVED DECISIONS): hotel_geocode_cache schema parity —
keep feasible-first (no backend-types.ts mirror, internal cache) or override to strict Pydantic+TS.

Then T1→T6 in order. Guardrails to hold (all folded from the Codex reviews, incl. the v2 re-review):
- Cache key = STABLE IDENTITY {provider,country,hotelId} (NOT the translated query — it doesn't exist
  pre-read); require a non-null/unique hotelId to cache; proximity is passed to geocode for biasing, NOT
  keyed AND NOT persisted.
- JP localized name MUST pass a Japanese-script-RATIO validator (NFKC, 1–120 code points, ≥2 JA chars,
  JA/(JA+Latin) ≥ 0.70, reject control/delimiter chars) BEFORE any Mapbox call — query_language=="ja" is
  TOO WEAK ("Imperial Hotel 東京" passes). English/mixed echo → skip → unresolved, zero paid geocode. Test it.
- POST-GEOCODE IDENTITY GATE (never pin an INVENTED or NON-HOTEL place, Guardrail #1): place a hotel ONLY if
  country matches AND (JP types=poi path) Mapbox's poi_category CONTAINS a lodging value. The gate's cacheable,
  trip-INDEPENDENT part is country + poi_category ONLY; the ≤60km proximity check is TRIP-SPECIFIC, re-runs in
  rank_hotels, and is NEVER inside the cache resolver (v5 #2 — else a hotel far from one trip's centroid gets
  negative-cached and hidden from a later trip near it). Extend the Search Box parser to keep feature_type +
  poi_category (fields we already fetch and discard — no new call). Catches the proven "vending machine" case
  the 60km gate can't. Unknown/absent category → NOT lodging → unresolved (fail-safe: a false "couldn't place"
  costs recall, never a wrong pin). Non-JP address path has no poi_category → country only in the resolver.
  ACCEPTED + WATCHED residual (ZH 2026-08-05, scope clarified v5 #1): the gate proves *a lodging in the right
  area*, NOT *this* hotel — ANY wrong same-area real lodging can survive (Mapbox wrong-branch on a correct
  name, OR localizer name-slot drift); always a real lodging, never invented/non-hotel. The heavier
  location-landmark LLM cross-check is DEFERRED until live /qa shows a real wrong-hotel pin. Test the
  vending-machine (non-lodging) rejection; do NOT assert the name-swap is caught (it is the accepted residual).
- Guardrail #11: server-assigned ORDINALS (NOT model hotelIds — an allowlist proves membership not
  pairing), ≤1 output/ordinal, snap-back; input guardrail run_in_parallel=False; fields
  escaped-JSON-in-delimiters, length-capped. Adversarial "known ordinal, wrong name" test.
- Cache stores found/miss (geocode fact), NEVER placed/unresolved (≤60km gate is per-trip, always
  re-runs). CHECK enforces coord⇔status AND country_code (found ⇒ all NOT NULL, miss ⇒ all NULL);
  re-validate cached rows via a strict CacheRow model (NOT the loose GeocodeResult). On a hit, a
  name_fingerprint mismatch (Travala ID-reuse / relocation) → treat as a read-miss + re-resolve.
- TTL is BOUNDED: found = 365d (identity→coord is MUTABLE, must self-correct — NOT no-TTL), miss = 14d;
  STRATEGY_VERSION invalidates algorithm changes only.
- Cache HIT skips translate+geocode (read cache first, translate only misses).
- Typed failures: valid-empty/invalid-localization → cacheable miss; translator/Mapbox-infra →
  ResolveError (NOT cached), re-raised BEFORE persist's broad except so prior hotel rows are PRESERVED
  (never a clobbering full-unresolved rewrite).
- In-process single-flight per key, owned by resolve_cached ALONE (T4 must NOT also claim/acquire —
  asyncio.Lock is not reentrant → a nested acquire deadlocks); the resolver closure runs
  translate+geocode+identity-gate under ONE lock hold. Residual of cross-worker overlap = duplicate
  BILLING, not corruption; telemetry + DB-lease mandatory before multi-instance. Pin web numInstances:1
  in render.yaml.
- Cache opt-in via injected client; new modules never imported at offline-eval scope (subprocess
  sys.modules test); rank_hotels stays pure/deterministic (resolve_hotels=None → byte-identical to today).

Verify: full backend suite green; offline eval anchor unchanged; then real /qa JP regen (hotels get
real JP coords, toggle enables, hub pin + spokes render, hotel_geocode_cache rows written, 2nd regen hits
cache). Final whole-branch review = astrail-reviewer on FABLE + gstack /review Codex (run both), then
PR into zh. Do NOT run ad-hoc live geocode probes (they bill Mapbox permanent $5/1000).

Separate tiny follow-ups (not this plan): hotel-pin bed glyph (FE, TripMap.tsx hub marker +
globals.css:624); property-photo pin (needs CSP img-src work).
```
