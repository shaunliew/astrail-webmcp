# Design — backend mem0 settings surface

> Date: 2026-08-02 · Branch: `feat/mem0-settings-surface` (from `origin/dev` @ `8d9dd39`)
> Board card: **"Frontend: replace mock SettingsView with real data…"** (Phase 1, Todo) — this spec
> covers the **backend half**, which the card does not currently represent.

## 1. Problem

A teammate reported "the mem0 API is not working" on the deployed backend
(`https://astrail-backend.onrender.com`). **It is working.** The broken layer is the frontend, and
there is no backend surface behind it.

### 1.1 What was proven (2026-08-02, live production data — evidence, not inference)

| Claim | Evidence |
|---|---|
| mem0 client constructs on Render | `memory_events` has 5 rows, **all** `event_type='learned'`, zero `'failed'`. Per `pipeline/preferences.py:129-138` a row is written **only** when `mem0 is not None` (early return otherwise, no row), and `'failed'` on any add error/timeout. A `'learned'` row is therefore proof the key was set and the client built. |
| mem0 **write** works | User `ccbf4851` typed `"nice food"` 07-31 16:03 → `memory_events learned` 16:05. |
| mem0 **read** works | Same user, 08-01 02:02, blank prefs → `preference_summary` = `"Using your saved travel preferences: …"`. Per `merge_preferences`, `source="memory"` is reachable **only** when `mem0.search()` returned non-empty facts. |
| Render key == local key | `sha256[:12]` compared across the boundary: `c7169f7e6f7d` both sides. (Compare secrets by truncated digest, never by value.) |
| Service healthy | `/health` 200, `/readiness` `{"ready":true}`, all `jobs` rows `succeeded`, no mem0 lines in Render logs. |
| `add()` is **asynchronous** | Round-trip probe returned `{'event_id': …, 'status': 'PENDING'}`; the memory became visible to `get_all` after **~8s**. |

### 1.2 The actual defect — `/app/settings` is a live route wired entirely to mocks

- `frontend/app/app/(shell)/settings/page.tsx` renders `SettingsView` — a real, reachable route.
- `frontend/components/settings/SettingsView.tsx:4` — `import { getProfile, clearMemory } from '@/lib/trip/mock-api'`. The **mock**, in production.
- `frontend/lib/trip/mock-api.ts:73-77` — `clearMemory()` is a no-op returning `{ok: true}`; `SettingsView.tsx:81` then renders **"Memory cleared."** → **a fake success message**.
- `frontend/lib/trip/supabase-api.ts:29` — even real mode hardcodes `facts: []` ("mem0 memory is a separate concern — `[]` in real mode for now").
- `backend/main.py` has **no `/settings/*` route**. `user_preference_facts` has **0 rows** and is written by nothing.

A frontend dev opening Settings sees zero facts and a Clear button that lies. The report was correct
about the symptom and wrong about the layer.

### 1.3 Secondary contributor — the trigger asymmetry

mem0 **writes only** when the user types preferences (`source=explicit`,
`distill_memory_text` returns `None` otherwise) and **reads only** when they leave it blank
(`build_preference_context` skips the search when explicit text is present). Type every trip → never
any recall. Never type → nothing is ever stored. Recall fires only on trip N+1 after a trip N that
had preferences typed. This is correct per PRD §9 "explicit wins", but it is invisible and
counter-intuitive. **Not changed here** — documented so the next person does not re-diagnose it.

## 2. Goals

> **SCOPE SPLIT — 2026-08-02, after two failed plan-review rounds.** `POST
> /settings/memory/clear` is **deferred to its own arc**. Rev 1 scored 3.6/10 and rev 2
> scored 3.9/10, and reading *where* the findings landed settled it: nearly every P1
> across both rounds belonged to the clear endpoint (strict-vs-best-effort semantics,
> timeout-means-outcome-unknown, a verification read that could itself report a false
> success, the clear-vs-write-back race, and "a destructive endpoint cannot be
> live-verified"). The read, the readiness field, and the PRD fix were never the problem.
> Everything about the clear below is retained as **input to that next arc**, marked
> DEFERRED — it is not in this build.

**This arc:**

1. `GET /settings/preferences` — the user's stored mem0 memories, read **live**.
2. A `mem0` field on `/readiness` — end the silent-failure blindness.
3. `distill_memory_text` stops appending the trip synopsis — PRD §357 compliance.

**Deferred to the clear arc:** `POST /settings/memory/clear` — the endpoint
`mock-api.ts:73` has been pretending to call. Until it ships, the frontend's Clear button
should be **honestly disabled** rather than left as a mock that fakes success.

Endpoint names are taken from **PRD §18** (`docs/PRD.md:820-821`), not invented.

## 3. Non-goals

- **Frontend wiring** — swapping `mock-api` → real API in `SettingsView` is Zhi Hao's (the board card).
- Per-fact deletion (PRD §10 says "clear preference memory", singular bulk action).
- Writing `user_preference_facts` — the live read makes the table unnecessary; it stays empty.
- Backfill-cleaning trip-history memories already in mem0 (destructive against live data; one real user).
- Changing the explicit/blank trigger asymmetry (§1.3) — PRD §9 behaviour, out of scope.
- **The async-`learned` bug — deferred, see §8.**

## 4. Design

### 4.1 The central rule: **the read degrades, the write must never fake success**

This is the lesson of §1.2 inverted into a contract.

- **`GET /settings/preferences`** follows guardrail #3. mem0 `None`, error, or timeout → **`200`** with
  `{status: "disabled"|"unavailable", facts: []}`. Settings renders "memory unavailable" rather than
  erroring the page. A memory outage must not break an unrelated settings screen.
- **`POST /settings/memory/clear` (DEFERRED — design retained for the clear arc)** does the
  **opposite**. If mem0 is `None`, or the delete confirmably failed → **`503`**, never
  `{cleared: true}`. It must not report success without having deleted something. **A clear that
  lies is the exact defect this spec exists to remove, and it is worse than an error, because the
  user believes their data is gone when it is not.** Note the correction from review round 1: a
  *timeout* is not a failure — see §4.2's three-outcome contract.

**This arc contains only the degrading read**, so §4.1's asymmetry does not yet appear in shipped
code. It is recorded here because it is the load-bearing design idea and the next arc inherits it.

### 4.2 Contracts

```
GET /settings/preferences
  200 {"status": "ok" | "disabled" | "unavailable",
       "facts": [{"id": str, "memory": str, "created_at": str, "source": "mem0"}]}
      status=ok          -> mem0 answered (facts may legitimately be [])
      status=disabled    -> MEM0_API_KEY unset; memory is off by configuration
      status=unavailable -> mem0 errored, timed out, or returned an unparseable shape

POST /settings/memory/clear                          # DEFERRED — the clear arc, not this one
  200 {"cleared": true}
  503 {"error": …, "code": "memory_unavailable"}     # CONFIRMED: nothing was deleted
  503 {"error": …, "code": "memory_clear_unknown"}   # outcome could not be confirmed
```

**Three outcomes, not two (added after review round 1).** Rev 1 mapped a timeout to
failure. That is the original lie pointing the other way: once the DELETE has been sent,
mem0 may well have committed it, so "nothing was cleared" can itself be false. On timeout
the endpoint performs one bounded verification read — memories gone → success; memories
present → `memory_unavailable`; verification itself unclear → `memory_clear_unknown`, and
the client is told to **refresh**, not blind-retry (a retry could erase facts written since
the first attempt).

**Concurrency (added after review round 1).** Generation takes 60-180s. If a user clears
memory mid-generation, the post-`result` write-back would re-add a fact — UI says cleared,
memory exists, which is the very defect this arc removes. `persist_trip_memory` therefore
skips its write when a `'cleared'` event is newer than the generation start. An endpoint
that promises never to fake a clear cannot leave a hole that silently un-clears it.

**No `count` field.** Reporting how many facts were removed would require a `get_all` immediately
before the delete — a second quota-consuming mem0 call, and a second thing that can fail, to produce
a number the UI never shows (`SettingsView.tsx:81` renders a fixed "Memory cleared." string). YAGNI.

### 4.2b The facts DTO — prose, not `UserPreferenceFact` (decided after review round 1)

Review caught that the Settings UI does not consume flat strings:
`lib/profile/memory.ts:4` calls `factToReceiptLine(fact: UserPreferenceFact)`, which
switches on `fact_key` (`likes_cuisine`, `prefers`, `avoids`, `style`) and also carries
`fact_value`, `source`, `confidence`, `status`.

mem0 does not return any of that. It returns prose:
`"User prefers traveling experiences that feature nice food…"`.

Three options were weighed. Mapping mem0's prose into `UserPreferenceFact` would have
required **synthesising `fact_key` and `confidence`** — inventing structured data to
satisfy a type, which is what guardrail #1 exists to prevent, and which would put a
fabricated confidence number in front of the user. Populating `user_preference_facts`
instead would match the UI exactly but reintroduces the cache-drift-from-mem0 that hid the
original diagnosis.

**Decision: return mem0's prose verbatim, tagged `source: "mem0"`.** The endpoint reports
only what mem0 actually holds. Adapting `SettingsView` to render `fact.memory` is part of
the frontend card. This trades a slightly larger frontend change for a response that never
lies about its own provenance.

### 4.3 mem0 calls (both verified live against the account this session)

- Read: `mem0.get_all(version="v2", filters={"AND": [{"user_id": uid}]})`
  — the v2 filter shape is mandatory; a top-level `user_id=` raises
  `ValueError: Top-level entity parameters … are not supported in get_all()`.
- Clear: `mem0.delete_users(user_id=uid)` → `{'message': 'Entity deleted successfully.'}` (verified).
  Note the kwarg is **`user_id`**, singular — `user_ids=[…]` raises `TypeError`.
- Both wrapped in `asyncio.wait_for` (existing convention, `preferences.py:94,133`): a hung hosted
  call must never wedge a request. Read timeout 4s, clear timeout 5s.

### 4.4 Auth and ownership (guardrails #5, #6)

`user_id` comes from `Depends(get_current_user_id)` (`backend/auth.py`, the existing seam used by
`/generate-trip` and `/saved-reels/organize/{job_id}`) — **never** from the request body, query, or a
path param. This *is* the owner check: the identifier is not user-supplied, so a user can only ever
read or clear their own memory. There is no trip or row to cross-check against.

Both endpoints carry the existing `@limiter.limit(BURST_LIMIT)`. Rationale beyond abuse: mem0's free
tier is quota-limited, and `GET` fires on every Settings page view.

### 4.5 Audit trail — zero migration required (DEFERRED with the clear arc)

> Nothing in **this** arc writes to `memory_events`. The finding below still holds and is
> the reason the clear arc will also need no migration — it is recorded here so the next
> arc does not have to re-derive it.


The clear writes `memory_events{user_id, trip_id: NULL, event_type: 'cleared', learned_facts_json: []}`.

Verified against the deployed schema: `memory_events.trip_id` is **nullable**
(`20260701131304_identity_persona_foundation.sql:123`), `'cleared'` is already permitted by
`memory_events_event_type_check` (line 127), and the partial index is explicitly
`where trip_id is not null` (`20260701151718_trip_job_backbone.sql:101`). The schema anticipated this
case. **No migration, so no deploy-ordering hazard** — the standing `autoDeploy: false` constraint in
`render.yaml` is not engaged by this arc.

The audit insert is best-effort (matching `preferences.py:140-147`): it must not fail a clear that
already succeeded.

### 4.6 `/readiness` mem0 signal

```
GET /readiness -> {"ready": true,
                   "mem0": "configured" | "disabled" | "init_failed" | "not_initialized"}
```

**Four states, not three.** `not_initialized` = key set, no construction attempt has happened yet.
Post-implementation it is effectively unreachable in production (requests are not served until the
lifespan yields, and the warm always attempts construction), but it is the honest value for the
window before that, and `mem0_status()` can return it — so the contract lists it.

**Not `"ok"` (corrected after review round 1).** `get_mem0_client()` memoizes; after the
first init it returns the cached object **without touching the network**
(`mem0_client.py:57`). Labelling that `"ok"` would assert connectivity that was never
tested. `configured` says exactly what is known: a key is set and the client built. A live
probe per poll was rejected — `/readiness` is polled by monitoring and would burn the
~1,000/month mem0 budget.

`MEM0_API_KEY` deliberately stays **out of** `REQUIRED_SECRETS`. Making it required would contradict
guardrail #3 and the explicit contract in `mem0_client.py:51-54` that `None` means *disabled, never an
error* — and would let a rotated or mistyped key take the whole backend down when trips do not need
mem0 at all. Instead the state becomes **visible**: `/readiness` is documented at `main.py:210-211`
as *not* the deploy gate (`/health` is), so reporting degraded mem0 cannot fail a rolling deploy.

The check must **never construct** a client. `get_mem0_client()` deliberately retries after a failure
(it leaves `_initialized` False so a transient boot blip does not disable memory process-wide), so
calling it from a polled probe would re-run an 8-second blocking constructor on every poll during an
outage. A dedicated non-networking accessor `mem0_client.mem0_status()` reads module state instead.

Vocabulary (the implementation uses `init_failed`, **not** `unreachable` — an earlier draft of this
line said `unreachable` and drifted from the code):
`disabled` = no key · `configured` = key set and client built · `init_failed` = key set, a
construction attempt failed · `not_initialized` = key set, no attempt yet.

**The same fork applies to `GET /settings/preferences`.** `list_memory_facts` only sees a `None`
client and cannot tell "no key" from "construction failed", so the route consults `mem0_status()` and
reports `unavailable` rather than `disabled` when the state is `init_failed`. Telling a user their
memory is switched off during an outage is the exact misdiagnosis this arc removes.

### 4.7 PRD §357 — stop storing trip history as preference memory

> *"Memory must not store raw full trip history as user preference data. It stores distilled
> preference facts only."* — PRD §357

Today `distill_memory_text` (`preferences.py:78`) returns
`f"Travel preferences: {ctx.explicit_text}. {synopsis}"`, so mem0 extracts **two** memories per trip.
Live proof from the account:

```
"User's travel preferences now include anime and pop-culture, good coffee, …"   <- preference  OK
"User has planned a four-day trip to Tokyo, Japan with a balanced pace"          <- trip history VIOLATION
```

And it reaches the product: the 08-01 recall read *"Using your saved travel preferences: …nice food…;
**User has planned a 20-day trip to Bangkok**…"*. Once `GET /settings/preferences` ships, that becomes
the visible content of the Settings page.

**Change:** drop the synopsis from the payload — `return f"Travel preferences: {ctx.explicit_text}"`.

`trip_synopsis()` exists **solely** to build this payload — verified: its only non-test caller is
`runner.py:548-554`. Once the synopsis is dropped it is dead code, and a parameter that is accepted
but ignored is a maintenance trap (the next reader will assume it works). So remove it **fully**:

- delete `trip_synopsis()` from `preferences.py`
- drop the `synopsis` parameter from `distill_memory_text()` and `persist_trip_memory()`
- update `runner.py:548-554` (drop the import, the call, and the stale reference in the comment at
  line 546)
- update the 4 call sites in `pipeline/test_preferences.py` (lines 40, 43, 45, 52)

This is the one place this arc touches the generation path. It is a payload change only — no
deterministic function is involved, so the `6229.0` anchor is unaffected (re-verified by §6).

Side benefits: roughly halves memories stored per trip (free-tier headroom) and removes trip-history
noise from the recall that feeds the restaurant/narrator prompts.

Existing trip-history memories are **not** backfill-deleted (non-goal §3).

## 5. Files touched

| File | Change |
|---|---|
| `backend/pipeline/preferences.py` | + `list_memory_facts()`, + `clear_memory()`; edit `distill_memory_text` (§4.7). 149 lines today — comfortably within the 200-400 target. |
| `backend/main.py` | + 2 routes; + `mem0` field on `/readiness`. |
| `backend/api/schemas.py` | + response models for both endpoints. |
| `frontend/lib/trip/backend-types.ts` | TS mirror — guardrail #4 schema parity. **No DB side**, so two sides, not three. |
| tests | new unit tests beside each (§6). |

**Frontend-file hazard (BUILD-LOOP.md):** VS Code format-on-save applies Prettier defaults against
this repo's single-quote / no-semicolon style. Write `backend-types.ts` via `Bash` heredoc, not
`Edit`, and check `git diff --stat` before committing.

## 6. Testing

- Unit tests inject a fake mem0 via the existing `_UNSET` sentinel convention — **no network**, so the
  offline `#16` eval import path stays credential-free and the client is never constructed at import.
- Cases per endpoint: happy path · mem0 `None` (disabled) · mem0 raises · mem0 times out
  (`asyncio.TimeoutError`) · empty-facts-is-not-an-error · **clear failure returns 503 and does NOT
  report success** (the regression test for §4.2) · audit row written on success.
- `distill_memory_text`: asserts the synopsis is absent and the preference text is intact.
- **Fault-injection is required per BUILD-LOOP** — for each new guard, state what makes the test red
  when the guard is removed, then delete the guard and prove it. Clear `__pycache__` first.
- `uv run pytest evals/ -q` must stay green (the `6229.0` anchor). Nothing here touches
  `dedupe`/`assemble_itinerary`; §4.7 changes only an LLM-prompt-adjacent payload.

## 7. Guardrail mapping

| Guardrail | How this satisfies it |
|---|---|
| #3 best-effort partial failure | `GET` degrades to `status` + `[]`; `/readiness` reports rather than fails; audit insert is best-effort. **Deliberate exception:** the clear is strict by design (§4.1). |
| #4 schema parity | Pydantic + TS mirror shipped together; no DB side. |
| #5 auth on every endpoint | `Depends(get_current_user_id)` on both. |
| #6 owner check | `user_id` is token-derived, never user-supplied — ownership is structural. |
| #7 write-through caches | N/A — no cache introduced; the live read is the deliberate alternative. |
| #11 untrusted content | No reel text enters these paths. |
| Eval-safety | No deterministic path touched; mem0 client stays lazy. |
| Stack freeze | No new dependency; `mem0ai` and `slowapi` already present. |

## 8. Deferrals (each with a concrete trigger)

1. **`memory_events` marks `'learned'` on an unverified async write.** `add()` returns
   `{'status': 'PENDING'}` (~8s to index) and `preferences.py:131-138` records `'learned'` on any
   non-raising return, so the audit can claim success the extraction never delivered.
   **Why deferring is safe now:** `GET /settings/preferences` reads mem0 **live**, so the user always
   sees the truth regardless of what the audit row asserts.
   **Trigger:** fix when a `'learned'` row is first observed with no corresponding mem0 memory.
2. **Backfill-clean existing trip-history memories.** **Trigger:** when more than one real user has
   them, or when a user reports trip history showing on the Settings page.
3. **`user_preference_facts` writes.** **Trigger:** when the live read's latency or mem0 quota becomes
   a measured problem — then, and only then, add the write-through cache (guardrail #7).
4. **The explicit/blank trigger asymmetry (§1.3).** **Trigger:** a PRD §9 revisit (the plan of record
   already documents the "explicit-wins-wholesale" deviation from blank-OR-incomplete merge).

## 9. Risk and rollback

Additive endpoints, no migration, no schema change → **rollback is a plain revert**. `/readiness`
gains a field (additive, non-breaking). The only behavioural change is §4.7, which affects what
*future* trips store; it touches no deterministic path, so the `6229.0` anchor is unaffected. Existing
stored memories are untouched.

**Concurrency:** a second Claude session is live in the primary worktree on
`feat/telegram-reel-ingest`. All work here happens in the isolated worktree
`/Users/shaunliew/Documents/astrail-worktrees/mem0-settings`. Stage explicit paths only — **never
`git add -A`** (BUILD-LOOP.md).

## 10. Open, not blocking

User `ccbf4851`'s mem0 entity no longer exists (`users()` returns only `621ef3d1`) despite the proven
successful read on 08-01. No delete path exists in the backend, the frontend, or anywhere in the repo,
and the diagnostic probe is exonerated (its dump showed 0 memories **before** any delete it made, and
`621ef3d1`'s 6 memories survived its scratch cleanup intact). Most probable explanation: a human
cleared the user in the mem0 dashboard while debugging. **Unverified.** Once `POST
/settings/memory/clear` ships with its `'cleared'` audit row, any future disappearance is
attributable.
