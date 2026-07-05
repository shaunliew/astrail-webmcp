# Backend AI Pipeline Revamp — Phased Roadmap (Planning Only)

> **Status: PLANNING ONLY. No code, no commits, no GitHub item edits.** Companion to the detailed Step-1+ implementation plan in `2026-06-28-agent-pipeline-spine.md` (which is now reframed — see §11). Produced by the Astrail planner role to run alongside the parallel Codex plan from issue #16, so the two can be reconciled before implementation.

**Author:** Shaun (backend). **Date:** 2026-06-28. **Anchor:** the only live backend issue, [MalaysiaKaki/astrail#16](https://github.com/MalaysiaKaki/astrail/issues/16) — currently **In progress** on the board.

> **SINGLE SOURCE OF TRUTH = GitHub Project #1 board, not repo issue lists.** The board (19 items) holds: 14 **draft** backend cards (Shaun, sequenced by Phase), 1 **live** backend issue (astrail #16, In progress), and 4 TripCanvas frontend issues (Zhi Hao). Backend roadmap items below reference **board draft cards by title + phase**, activated into real issues one at a time the way #16 was. Repo issue numbers are NOT authoritative.

**Sources aligned:** **GitHub Project #1 board (canonical task tracker)** · `docs/PRD.md` · `.claude/CLAUDE.md` · `AGENTS.md` (thin pointer) · legacy `legacy/tripcanvas-hackathon/backend/spike_*.py` · OpenAI Agents SDK docs · mem0 platform skill.

**Guiding principle (from CLAUDE.md stack freeze):** *"easier and lesser is better"* — defer every tool until a real problem forces it. One step at a time; measure before rewriting.

---

## 0. Doc alignment summary (what each source says, where they agree/conflict)

| Source | Says about the backend agent work | Alignment |
|---|---|---|
| **GitHub Project #1 board (canonical)** | 14 backend **draft cards** (Shaun) sequenced by Phase: 1.1 = eval (#16), harness, specialist split, latency, Apify, dedupe, feasibility, fixture/cache, epic · 1.2 = hotel · 1.3 = mem0. **Only #16 is a live issue (In progress).** 4 TripCanvas frontend issues are Zhi Hao's lane. | The board IS the roadmap. #16 = Step 1. Phase fields drive ordering. |
| **PRD.md** | §19 5-phase pipeline; §20 Agents SDK rules; §25 evaluation dataset (Langfuse golden set + LLM-judge); §27 milestones (Weeks 3–4 "first 10 Japan eval sets"). | Eval-first ordering matches PRD Weeks 3–4. |
| **CLAUDE.md** | Build order #6–#15 (port extractor → enricher → narrator → restaurant → hotel → transport → orchestrator → caches → pipeline). 12 non-negotiable guardrails. mem0 + Sessions + structured prefs. | Build order is implementation-sequence; the roadmap front-loads measurement + the highest-leverage quality steps. |
| **Legacy spikes** | Working extractor (`tool_choice=required`, evidence checks, gpt-5.5→gpt-4o fallback), name-only dedup, tool-less `max_turns=1` narrator, booking/flights (BANNED in v1). | Port the good parts; the 3 known weaknesses are the quality targets. |

**One conflict to flag:** CLAUDE.md's "Owners" block still lists `Shaun owns #4,#5,#7–#11` — that maps to the **old TripCanvas** numbering, not the current astrail issues. The astrail issues are the source of truth now. (Recorded; CLAUDE.md ownership line should be updated in a later docs pass, not now.)

**Convergence:** all five sources point to the same first move — **a repeatable offline Japan eval baseline before any pipeline rewrite.** That is issue #16.

---

## 1. Recommended immediate next issue — and why it's first

**→ Work issue #16: "Backend P0: offline eval set for Japan beta planning."**

Why #16 is first (not the pipeline rewrite):

1. **You can't claim "better than legacy" without a number.** Every revamp goal — lower latency, higher extraction accuracy, better recommendations, working memory — is a *measurable* claim. With no eval, every change is a vibe. #16 turns the goal falsifiable.
2. **It's the contract every later step plugs into.** Steps 2–11 each land against the same fixtures and pass/fail gates. Build the ruler before cutting.
3. **It's offline and tiny** — fixtures + a runner, no Apify, no Supabase, no live LLM dependency for the harness itself. Smallest possible first ticket, exactly the "keep the first milestone small" constraint.
4. **It matches the PRD** (§25 eval dataset; Weeks 3–4 "first 10 Japan eval sets") and the board (#16 is the only open issue).
5. **The parallel Codex plan proposes the same Step 1**, so the two plans already converge here.

---

## 2. Exact v1 beta backend agent scope (Japan-first, tight)

```
v1 BETA BACKEND AGENT SCOPE  (the agent quality loop, in-memory, measurable)

  IN SCOPE (this revamp)                         OUT OF SCOPE (deferred / banned)
  ────────────────────────                       ──────────────────────────────
  ✓ Offline Japan eval baseline (#16)            ✗ Supabase persistence / auth / RLS
  ✓ Fixture/cache generation harness (#2,#8)     ✗ SSE streaming endpoint
  ✓ Latency instrumentation + traces (#6)        ✗ Frontend wiring / Mapbox GL UI
  ✓ Specialist agent contracts (#5)              ✗ Durable jobs table
  ✓ Direct Apify reel extraction (#9)            ✗ Restaurant / weather / hotel agents (later)
  ✓ Place extract / dedupe / evidence (#10)      ✗ Mapbox Search/Directions live (later step)
  ✓ PreferenceContext + mem0 memory (#4)         ✗ Booking / payment / flights (BANNED)
  ✓ Narrator (ported) + minimal summary          ✗ Convex / Clerk / Google Places (BANNED)
                                                  ✗ Agents SDK/MCP in the Apify scrape loop (BANNED)
```

**Japan-first:** all fixtures, the Mapbox bbox sanity check, and the locale derivation target Japan (Tokyo demo set) for v1 beta. Other regions are a fast-follow, not a v1 gate.

**The measurable target loop for v1:** `reels → extract → dedupe(evidence) → enrich → [memory-personalized] → narrate` runs in-memory, faster and more accurate than legacy, proven by the #16 eval.

---

## 3. Step-by-step revamp roadmap (ordered, mapped to issues)

Steps map to **board draft cards** (by title + Phase), not repo issue numbers. Only #16 is currently a live issue.

```
STEP  WHAT                                        BOARD CARD (phase)                         GATE / WHY HERE
────  ──────────────────────────────────────────  ─────────────────────────────────────────  ────────────────────────────────
 0    Planning + contract alignment (THIS DOC)     —                                          docs+board agree before code   ← here
 1    Offline Japan eval baseline + runner         #16 "offline eval set" (1.1, IN PROGRESS)   measurable target first        ← DO FIRST
 2    Fixture/cache generation harness             draft "offline pipeline harness" +          run pipeline offline, no Apify/db
                                                    "fixture/cache fallback path" (1.1)
 3    Latency instrumentation + Langfuse traces    draft "latency instrumentation+traces"(1.1) know where the seconds go
 4    Specialist agent contracts + boundaries      draft "specialist agent split" (1.1)        freeze Pydantic I/O between stages
 5    Direct Apify reel extraction (live path)     draft "direct Apify Reel extraction" (1.1)  real reels, direct HTTP (no MCP)
 6    Place extract → resolve → dedupe → evidence  draft "place dedupe + confidence" (1.1)     the accuracy + flywheel win
 7    Narrator + feasibility checks                draft "itinerary feasibility checks" (1.1)  itinerary assembly + route sanity
 ───  ── Phase 1.1 core agent-quality loop complete ──
 8    Hotel/base recommendation reasoning          draft "hotel/base recommendation" (1.2)     secondary recommendation agent
 9    PreferenceContext + mem0 memory              draft "mem0 preference memory" (1.3)        personalization (2nd-trip win)
 ───  ── v1 beta agent quality done; below is fast-follow / separate epic ──
10    Mapbox Search/Directions (backend calls)     (new draft to create)                       grounded coords + real route legs
11    Durable jobs + Supabase + SSE + frontend     draft "planner/SSE tests" +                 integration layer (separate epic)
                                                    "evidence+tradeoff frontend contract"
```

**Note on ordering vs your stated goals:** the board sequences **mem0 memory at Phase 1.3** (Step 9), *after* the 1.1 core loop and 1.2 hotel. You named memory as a core revamp goal — if you want personalization earlier, that's a board re-prioritization to make with Codex (move the mem0 card from 1.3 into 1.1). This plan follows the board's current phase order; flag it if you want to pull memory forward. **← confirm.**

**Sequencing rationale (validated against the sources):**
- **Eval (1) before pipeline (5–8)** — PRD §25 + the "measure before rewrite" principle.
- **Harness (2) + latency (3) before live Apify (5)** — you want offline reproducibility and a latency baseline *before* introducing the slow network call, so you can attribute regressions.
- **Contracts (4) before parallelizing agents (6–8)** — the Pydantic boundaries between stages must be frozen so the fan-out (`asyncio.gather`) is safe and the eval checks are stable. This is CLAUDE.md guardrail #4 (schema parity) applied early, minus the TS mirror (deferred with the frontend).
- **Extraction/dedupe (6) before memory (9)** — memory personalizes *recommendations over places*; the place layer must be trustworthy first. (Board places memory at 1.3; see the ordering note above if you want it earlier.)
- **Mapbox (10) after the core loop** — per your direction: prove the agent loop first; add Mapbox grounding once the contracts are stable. Backend may call Mapbox Search directly for coordinate resolution (PRD §11) when we get there.

**Latency approach (Step 3 + applied in 6–8), grounded in OpenAI guidance:** fan out independent specialist agents concurrently with `asyncio.gather` and fan in to a summary step. Do **not** use the "agent-as-tool" orchestration route — the OpenAI cookbook is explicit that it adds latency (an extra upfront planning call plus tool-call overhead/context). Source: https://developers.openai.com/cookbook/examples/agents_sdk/parallel_agents

**Memory architecture (Step 7), grounded in mem0 + your constraint:** retrieve mem0 memories **once** per generation, normalize into a single `PreferenceContext` object, and inject it into the agents' prompts. Do **not** give each specialist its own `search_memory`/`save_memory` tool (mem0's default Agents-SDK pattern) — that multiplies latency and cost and fragments the preference view. Write-back (`mem0.add`) happens once at the end of a successful trip. Sessions vs mem0: SDK **Sessions** carry within-conversation message history; **mem0** distills durable cross-trip preferences — use mem0 for "remembers I love ramen across trips," not Sessions. Sources: mem0 platform skill (retrieve→generate→store); https://developers.openai.com/api/docs/guides/agents/running-agents#choose-one-conversation-strategy

---

## 4. Issue #16 — refined scope (what it should actually cover NOW)

#16's body lists checks for restaurant relevance, hotel/base reasoning, and memory use — but **those agents don't exist yet**, so #16 cannot run them end-to-end. Refine #16 into a **harness + tiered checks** so it stays a single small ticket and becomes the scaffold every later step plugs into:

**#16 delivers:**
1. An **eval harness + local runner** (`backend/evals/`) that loads cases, runs the available pipeline, reports per-stage pass/fail + timing, and exits non-zero on failed *active* contractual checks.
2. **3–5 Japan-first cases** as fixtures (ReelData + known places), including a **first-time** user case and a **second-time** user case (the second-time case asserts personalization *should* use stored memory).
3. A **two-tier check contract:**
   - **Active checks (run now, against the ported legacy baseline):** place evidence is a verbatim quote · coordinates present + inside a Japan bbox · day count == date span · route sanity (intra-day travel under threshold) · hallucination rate (missing coords / placeholder URL) · per-stage + total latency captured.
   - **Pending checks (defined as fixtures + expected contracts, marked skipped/xfail until their step lands):** restaurant relevance (→ Step 10) · hotel/base reasoning (→ Step 10) · memory-use on second trip (→ Step 7).
4. A **captured legacy baseline** — the numbers the new pipeline must beat (extraction evidence coverage, dedupe correctness, mean intra-day travel, latency).

```
#16 EVAL HARNESS — tiered so it ships small but scaffolds everything

  cases/japan_*.json ──► runner ──► [ACTIVE checks] ─► pass/fail + timing ─► exit code
        │                   │        evidence, coords,
        │                   │        day count, route,
        │                   │        hallucination, latency
        │                   └──────► [PENDING checks] ─► skipped (await Steps 7,10)
        │                            restaurant, hotel, memory
        └─ first-time case + second-time(memory) case + known legacy weaknesses
```

---

## 5. Non-goals for issue #16

- Do **not** build or rewrite any agent (extractor/enricher/narrator/restaurant/hotel/memory). #16 measures; it does not implement the pipeline.
- Do **not** wire Supabase, auth, SSE, durable jobs, or the frontend.
- Do **not** call live Apify, Mapbox, or Travala in the harness — fixtures only (a live smoke path can be added later, behind a flag).
- Do **not** implement restaurant/hotel/memory logic — only define their *expected checks* as pending.
- Do **not** reintroduce booking/payment/flights, Convex, Clerk, or Google Places.

---

## 6. Acceptance criteria for issue #16

- [ ] Eval cases live under `backend/evals/` (cases + fixtures + runner), committed to the repo.
- [ ] Each case defines: input fixture, expected **active** checks, **pending** checks (marked), and the known legacy weakness it targets.
- [ ] At least one **second-trip** case asserts personalization should draw on stored memory (pending until Step 7 / #4).
- [ ] The runner reports per-stage pass/fail and per-stage + total timing.
- [ ] The runner **exits non-zero** when an *active* contractual check fails; pending checks report as **skipped**, never as failures.
- [ ] The **legacy baseline** is captured as reference numbers in the repo, so later steps have a documented bar to beat.
- [ ] Unit-testable check functions (evidence coverage, hallucination rate, intra-day travel) have tests and run with **no API key**.

---

## 7. Steps blocked by docs/contracts that must align first

| Blocked step | Blocked on | Resolve by |
|---|---|---|
| Step 4 specialist contracts | Final Pydantic I/O shapes between stages (PRD §19/§20) — esp. `source_type`, evidence fields | Freeze model shapes in Step 4 before fan-out; defer the `backend-types.ts` mirror until frontend |
| Step 9 memory (mem0, board 1.3) | `PreferenceContext` shape + mem0 `user_id` scoping; PRD §10 memory requirements | Define `PreferenceContext` in Step 4 contracts; one mem0 read per run |
| Step 10 Mapbox | Mapbox storage-rights question (PRD §21 caveat) for caching geocodes | Confirm permanent-storage terms before persisting Mapbox coords globally |
| Step 11 persistence/SSE | Supabase schema + RLS (CLAUDE build #3) + SSE contract | Separate epic; not a v1 agent-quality gate |

---

## 8. Follow-up GitHub tickets to keep as DRAFT until needed

These already exist as **draft cards on Project #1** — **activate one at a time** into a real issue (set the card to In progress) as each step starts, exactly how #16 was activated. Keep the rest as drafts:

- "offline pipeline harness" + "fixture/cache fallback path" → Step 2. "latency instrumentation+traces" → Step 3. "specialist agent split" → Step 4. "direct Apify Reel extraction" → Step 5. "place dedupe + confidence" → Step 6. "itinerary feasibility checks" → Step 7. "hotel/base recommendation" → Step 8. "mem0 preference memory" → Step 9.
- **New draft to create later:** "Backend: Mapbox Search/Directions backend integration" (Step 10) — not on the board yet.
- "planner/SSE tests" + "evidence+tradeoff frontend contract" → Step 11 integration epic.

**Codex currently owns board edits — do NOT change board items from this session. Flag this step↔card mapping to Codex so the board stays the single source of truth.**

---

## 9. Risks / open questions from PRD.md & CLAUDE.md

1. **Model availability** — PRD/CLAUDE pin primary `gpt-5.5-2026-04-23` with typed `gpt-4o` fallback. Eval timing must be captured on the fallback too, or latency numbers won't be comparable. *(Open: is gpt-5.5 reliably available in our region?)*
2. **Mapbox storage rights** (PRD §21 caveat) — can we cache Mapbox-derived coords in a permanent place cache, or only per-trip? Blocks the Step 6 flywheel design and Step 9. *(Open — needs a terms check.)*
3. **Open validations not yet closed** (CLAUDE.md) — (a) Mapbox Search Box coordinate quality on the Japan demo set; (b) whether place cards need live ratings only Google had; (c) Travala latency/quality. These gate Steps 6/9/10, not #16.
4. **mem0 cost/latency at the eval gate** — second-trip personalization needs a mem0 round-trip inside the latency budget. *(Open: measure mem0 read latency in Step 3.)*
5. **Transcript fallback** — PRD/CLAUDE allow opt-in Apify `includeTranscript` when caption+location are thin. The eval should include one thin-caption case so this path is exercised in Step 5.
6. **Partial-failure behavior** (guardrail #3, PRD §17) — eval must assert the itinerary still renders when a secondary check is pending/failed. Bake into #16's runner semantics (pending ≠ fail).

---

## 10. Implementation prompt for the next session (use AFTER this plan is approved)

> Use astrail-execute-plan. Read `.claude/CLAUDE.md` and `docs/PRD.md` §25.
> Implement **Step 1 only: issue #16 — offline Japan eval baseline**, scoped per
> `docs/superpowers/plans/2026-06-28-backend-revamp-roadmap.md` §4–§6.
> Build `backend/evals/` (cases + Japan fixtures + runner) with the two-tier
> ACTIVE/PENDING check contract. Active checks run against the ported legacy
> baseline; pending checks (restaurant, hotel, memory) are scaffolded as skipped.
> TDD: pure check functions first, no API key required for the unit suite.
> Do NOT build any agent, Supabase, SSE, Mapbox, or live Apify. Do NOT exceed #16.
> Capture the legacy baseline numbers. Reference `MalaysiaKaki/astrail#16` in commits.

---

## 11. How this reframes the earlier `agent-pipeline-spine.md` plan

The detailed 9-task plan in `2026-06-28-agent-pipeline-spine.md` is **not** Step 1 as written — it bundled the whole pipeline + eval. Reframed against this roadmap:
- Its **Task 9 (eval harness + golden set)** → becomes **Step 1 / issue #16** (expanded with first/second-trip + pending checks).
- Its **Tasks 1–8 (models, runtime, extractor, dedup, enricher, feasibility, narrator, runner)** → become the detailed plans for **Steps 4–8**, activated one issue at a time.
- Keep that file as the detailed reference for the pipeline steps; this roadmap governs ordering and scope.

---

## 12. Reconciliation with the parallel Codex plan

Codex is planning from #16 in parallel. Expected convergence: **Step 1 = offline Japan eval baseline** (both agree). Diff to check when Codex returns:
- Eval directory convention (`backend/evals/` vs `backend/tests/fixtures/`) — pick one.
- Whether Codex includes the legacy baseline capture inside #16 (this plan does).
- Memory architecture (this plan: retrieve-once `PreferenceContext`, not per-agent tools) — confirm Codex agrees.
- Latency approach (this plan: `asyncio` fan-out, not agent-as-tool) — confirm Codex agrees.
Reconcile the two, then approve, then run the §10 prompt.
```
