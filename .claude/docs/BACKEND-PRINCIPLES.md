# Backend Engineering Principles (Astrail) — apply where they earn their place

> A **calibrated** reference for the backend engineer/reviewer subagents: what each principle/pattern
> MEANS, exactly WHERE it already lives (or should live) in Astrail's backend, and — just as important —
> where invoking it would be OVER-ENGINEERING for a weekend-team v1 beta. **Feasible-first governs:**
> reach for a principle when a real force in THIS codebase calls for it, never as ceremony. This doc
> names concepts; the load-bearing rules are still `.claude/CLAUDE.md` (the 12 guardrails) +
> `.claude/docs/`. When a "best practice" here conflicts with feasible-first, feasible-first wins unless
> the user says otherwise.

## Design principles

**SOLID**
- **SRP (single responsibility)** — the repo's "many small files, 200–400 lines, one responsibility"
  rule. A route module routes; `pipeline/` orchestrates; `genagents/` agents interpret; `persist.py`
  writes. Split by responsibility, not by technical layer. This is the SOLID principle that matters most here.
- **DIP (dependency inversion) — the codebase's testing seam.** `pipeline/runner.py` takes
  dependency-injected adapters (supabase / mem0 / httpx clients) so the offline `#16` eval stays keyless
  and deterministic. New code that calls an external service MUST be injectable the same way (accept the
  client as a param; default-construct it lazily) — never hard-wire a live client a test can't replace.
- **OCP / LSP / ISP** — honor implicitly (extend via new agents/stages, not by editing frozen seams;
  keep interfaces narrow). Do NOT introduce abstract base classes / plugin registries speculatively —
  add an abstraction only when a second concrete implementation actually exists.

**TDD (mandatory)** — RED (write the failing test, run it, watch it fail for the right reason) → GREEN
(minimal implementation) → REFACTOR. Tests verify real behavior, not mocks. Every guard must be
*load-bearing*: the reviewer reverts it and watches the test go red. The `#16` eval anchor (`6229.0`) is
the regression net for the deterministic pipeline.

**Immutability (CRITICAL)** — return NEW objects; never mutate inputs. Pydantic: `model_copy(update=…)`.
Frozen dataclasses for value objects (`PreferenceContext` is `frozen=True`). Immutability is what makes
the concurrent `asyncio.gather` fan-out safe — there is no shared mutable state to race on.

## Concurrency, streaming, messaging

**Async, NOT multithreading.** Astrail's concurrency model is a single-process asyncio event loop —
`asyncio.gather` for the parallel enrich stages, `background.add_task` for the live runner. Do NOT
introduce `threading` / `ThreadPoolExecutor` as a concurrency model (the one existing exception is the
tiny single-worker executor that *bounds a blocking client constructor* in `mem0_client.py` — a timeout
guard, not concurrency). I/O is the bottleneck, not CPU, and async covers it. FastAPI runs sync `def`
handlers in a threadpool for you — prefer `async def` since our I/O is async-native (async supabase-py,
`httpx.AsyncClient`, Agents SDK).

**Streaming + backpressure** — the SSE contract (`backend/api/streaming.py`) is FROZEN: raw `data:`
frames + the `data: [DONE]` sentinel + seen-set replay (guardrail #4, the single most breaking contract
in the repo). Stream incrementally; never buffer a whole itinerary to emit at once. The rate-limit gate
checks at connection-open only, not per-frame.

**Messaging / queue** — v1 has NO external message broker. The **durable `jobs` table IS the queue**
(enqueue a row → CAS-claim → run → startup re-sweep of `in_progress`), and `generation_events` is the
progress event log. A real broker (ARQ + Redis / Render background workers) is DEFERRED to v2, triggered
by Render scaling past one instance. Model new async work as a durable job row, not an in-memory task you
can lose on restart (guardrail #12).

## Reliability

**Idempotency (guardrail #12)** — every trip generation carries a request-derived idempotency key; a
replay returns the same trip, never double-generates. Enrich persisters **delete-then-insert** their own
rows for retry safety. Any new write that can be retried must be idempotent (idempotency key,
`upsert(on_conflict=…)`, or delete-first). Recovery is restart-with-cache-reuse, NOT mid-run resume.

**Caching — write-through (guardrail #7)** — `reel_cache` (scrape + extraction), the global `places`
dedup-on-write flywheel: all persist BEFORE returning. Cache-aside reads are fine; writes are
write-through so a crash can't leave a returned-but-unpersisted result. Invalidate by bumping a version
column (`EXTRACTOR_VERSION`), not by clearing.

## Security

**Auth / JWT / OAuth** — every endpoint authenticates (guardrail #5); no anonymous trip creation.
Supabase Auth runs the **OAuth** (Google) flow on the frontend; the backend only **validates the JWT** —
ES256 / JWKS asymmetric verification in `auth.py` (algorithm-confusion-guarded, JWKS cache with
lock/TTL). New endpoints reuse the existing `Depends(get_current_user_id)` — do not hand-roll token
parsing. Per-authenticated-user quotas key on the JWT's user id (see the rate-limit design).

**Owner check (guardrail #6)** — every trip read/write verifies `trip.user_id == current_user.id`,
enforced by Supabase RLS, not just app code.

**SSL / TLS** — Render terminates TLS at the edge (HTTPS-only) and Supabase connections are TLS; the
app-layer concern is **never leaking a secret**. Mapbox puts its token in the URL, so errors are
sanitized to token-free messages before any log/exception. No secret (Apify/OpenAI/Mapbox/Supabase) in
any raised exception, log line, or print — ever.

**Input validation at boundaries** — validate all external input (request bodies via Pydantic with
explicit bounds like `max_length`; reel content is UNTRUSTED — guardrail #11 — and rides the Agents SDK
input guardrails). Fail fast with a clear error; never trust an API response or a user-supplied field.

## Design patterns — use judiciously, never as ceremony

Reach for a pattern when it removes a real force; naming a pattern is not a goal. Astrail already uses:

- **Singleton (lazy)** — `get_supabase_client` / `get_mem0_client`: one process-wide client, built on
  first use behind a double-checked lock, NEVER at import (import-keyless invariant). Keep singletons
  *injectable* so tests replace them — a global you can't swap is the anti-pattern.
- **Factory** — the same lazy getters double as factories; prompt/agent builders assemble configured
  objects. Don't build an AbstractFactory hierarchy for one product.
- **Decorator** — Python decorators for cross-cutting concerns: FastAPI route decorators, `@limiter.limit`
  (slowapi), and `Depends(...)` for auth / rate-key injection. This is the idiomatic seam for
  rate-limiting + auth — not a bespoke middleware class.
- **Observer** — the SSE event stream is an observer relationship (the client observes
  `generation_events`); Supabase Realtime is the same shape on the frontend. Don't build an in-process
  Observer framework — the event log + SSE already is one.

**The over-engineering line (enforced in review):** no speculative abstraction, no pattern without a
second concrete case, no threads where async fits, no broker where a jobs table fits, no ABC where one
implementation exists. A working, minimal, well-named whole beats a pattern-decorated part
(`feasible-first-policy`).
