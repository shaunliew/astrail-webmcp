# Astrail addendum — vendored `fastapi` skill

> This directory is a **verbatim vendored copy** of the official FastAPI agent skill. Do NOT edit the
> vendored files (`SKILL.md`, `references/*`) — keep them byte-identical to upstream so re-vendoring is a
> clean diff. This addendum (NOT part of upstream) records the source pin + Astrail-specific guardrails.

**Source:** `fastapi/fastapi` @ `3f3354a94d7c8b496258d7b762070e46704e01c1`, path
`fastapi/.agents/skills/fastapi/` (also in `.upstream-commit`). Re-vendor from that exact path; overwrite verbatim.

## Use it for

Modern FastAPI idioms when writing/editing endpoints:

- `Annotated[..., Depends(...)]` dependency injection with named type aliases.
- No `...` (Ellipsis) defaults; no Pydantic `RootModel`.
- No deprecated `ORJSONResponse` / `UJSONResponse` (Pydantic serializes on the Rust side now).
- Router-level `prefix` / `tags` / `dependencies` on `APIRouter`.
- `async def` only when the body is truly non-blocking, else sync `def` (thread-pooled). Astrail's I/O is
  async-native (async supabase-py, `httpx.AsyncClient`, Agents SDK), so async is usually correct here.

## GUARDRAIL — do NOT let this skill migrate the SSE contract (guardrail #4)

The skill prescribes `response_class=EventSourceResponse` + `yield ServerSentEvent(...)` for SSE.
**Astrail's SSE contract is hand-rolled and FROZEN** — `backend/api/streaming.py` emits raw
`data: {json}\n\n` frames, terminates every path (incl. errors) with the literal `data: [DONE]\n\n`
sentinel, and `stream_trip_events` does seen-set / poll reconnect-replay. The frontend breaks on
`data: [DONE]`. This is the single most breaking contract in the repo (`.claude/docs/ARCHITECTURE.md`,
guardrail #4 schema/contract parity).

- Do **NOT** migrate `streaming.py` to `EventSourceResponse` / `ServerSentEvent`, rename the `[DONE]`
  sentinel, or change the raw `data:` frame format — unless a reviewed PLAN explicitly mandates it.
- Native `EventSourceResponse` is a legit **future** upgrade (typed/OpenAPI event schemas +
  `Last-Event-ID` resumability) but a deliberately-gated decision, not a byproduct of using this skill.

## Astrail conventions the skill does NOT cover (still binding)

Lazy imports (import `openai` / `agents` / `httpx` INSIDE functions, never at module top — the
import-keyless invariant), async supabase-py usage, the durable-jobs / recovery contract (#12),
eval-safety (`mean_intra_day_travel_m = 6229.0`), and token safety (no secret in any exception/log/print).
The `fastapi` skill is a code-idiom guide — not a substitute for `.claude/CLAUDE.md` + `.claude/docs/`.
