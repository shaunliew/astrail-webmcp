# Standard Feature Build Loop (Astrail backend)

> **The mandatory end-to-end workflow for building ANY backend feature.** Read this before you start a
> feature — planning OR implementing. It is the loop that shipped every Phase-1 backend arc (runtime
> spine → persistence → the enrich agents → latency → mem0 memory), and it exists for **teammate
> alignment**: shared review artifacts, one board as source of truth, a consistent workflow everyone
> follows. **Do not shortcut it to save time.** Feasible-first still governs *scope* within each step
> (ship the smallest working whole, defer polish behind a trigger); this governs *process*.

Trigger: the user says "build X" / "implement X" / "add feature Y", or you're about to plan or code any
backend change beyond a trivial one-line fix. When in doubt, follow the loop.

## The loop — do these in order

0. **Task from the board.** Confirm *what* you're building against **GitHub Project #1** (the
   `astrail-task-tracking` skill / `gh project item-list 1 --owner MalaysiaKaki`) — the single source of
   truth for what's next and its ordering. Not from memory or `gh issue list`.

1. **Research** *(only if the step touches an unfamiliar API/SDK/algorithm or code seam).* Dispatch the
   **`astrail-researcher`** subagent (read-only): a tight cited synthesis + a feasible-first recommendation.
   Ground external facts in live sources (Mapbox/OpenAI docs MCP, the installed package, Supabase skills) —
   never memory.

2. **Plan.** Use the **`astrail-plan-and-review`** skill → its brainstorming interview → `superpowers:writing-plans`.
   Save to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`. Scope feasible-first; every task has exact code /
   files / tests; **list every deferral with a concrete trigger**; map each task to the guardrails + contracts.

3. **Review the plan — REQUIRED before any code.** Run gstack **`/plan-eng-review`** (it logs the review
   report teammates read) **AND** the **Codex** outside voice (`/codex:rescue Review this plan …` or the
   skill's `codex exec` pass). Fold every blocking finding into the plan file. A plan is not "ready" until it
   passes (overall ≥ 7, no dimension ≤ 3). This routinely catches P1s at zero cost — the mem0 plan review
   caught 3 (idempotency, hang-timeouts, GC'd write-back) before a line of code.

4. **Implement task-by-task via `superpowers:subagent-driven-development`.** One **`astrail-developer`** per
   task (TDD; transcribe the plan's code faithfully — its blocks already encode review folds; run tests;
   commit) → an **`astrail-reviewer`** per-task gate (spec + quality + adversarial; **the reviewer
   fault-injects to prove each guard is load-bearing**) → fix loop until clean → mark the task in the ledger
   `.superpowers/sdd/progress.md`. Never run two implementers in parallel. Amendments in the plan supersede
   inline task code — tell the developer which.

5. **Final whole-branch review (fable).** One **`astrail-reviewer`** over the WHOLE arc diff, `model: fable` —
   verifies every guardrail end-to-end against the code + migration DDL + FE contract, and triages the
   accumulated deferred Minors.

6. **Cross-model code review — REQUIRED, the step that earns its keep.** Run gstack **`/review`**; its
   **Codex cross-model pass on the CODE** catches bugs the Claude reviews (even the opus whole-branch pass)
   MISS. On the mem0 arc it caught **2 real production bugs every Claude reviewer missed** — an idempotency-key
   `|`-join collision (wrong-trip replay) and a `mark_job_done` failure flipping a completed trip to `failed`.
   Fix its findings + re-verify. **Run BOTH step 5 and step 6** — they have different blind spots; one is not a
   substitute for the other.

7. **Live-verify.** A real smoke against the live stack (`backend/scripts/live_run.py` or a focused script) —
   prove the feature works end-to-end, not just in unit tests. For **UI / auth / SSE / Mapbox / full-flow**
   changes, gstack **`/qa`** evidence is required. Credit-spending or live-DB runs: get the user's go first.

8. **Ship.** Open a PR to `dev` with the review trail + live evidence in the body; merge; fast-forward `shaun`
   to `dev`; delete the feature branch (local + remote). **Commit / push / PR only when the user asks.**

9. **Record.** Update the repo docs the change affects (`.claude/docs/ARCHITECTURE.md`, `docs/PRD.md`, this
   file, CLAUDE.md), **EMDEE** (Zhi Hao's SHARED vault — the `DECISIONS LOG` entry + a `ROADMAPS` status
   snapshot; **never the local mirror**; the shared vault IS writable despite INFO.md's blanket note), and
   memory. Hand **Codex** the board-card update (Codex owns GitHub Project mutations).

## Non-negotiables that hold across every step

- **Eval-safety.** The frozen `#16` offline anchor `mean_intra_day_travel_m = 6229.0` must never move — run
  `uv run pytest evals/ -q` after every change. Personalization / enrich reach the trip **only via LLM
  prompts**, never the deterministic `dedupe`/`assemble_itinerary`, and nothing the offline eval imports may
  construct a live client.
- **The 12 guardrails** (CLAUDE.md): best-effort partial failure (#3), owner checks (#6), no hallucinated
  places (#1), untrusted reel content (#11), durable jobs / restart-with-cache-reuse (#12), write-through
  caches (#7), schema parity (#4), etc.
- **Reviewers verify against the actual code, never the report**, and fault-inject to prove a guard is
  load-bearing (revert the guard → watch the new test go red → restore).
- **Both final reviews run** (astrail-reviewer opus whole-branch **AND** gstack `/review` Codex).

## Subagent result delivery (learned 2026-07-19 — cost ~5 wasted round-trips in one session)

**A background subagent's plain final text is NOT delivered to the orchestrator.** It must call
`SendMessage` with `to: "main"`. Without that the agent finishes its work, produces a report nobody
receives, and surfaces only as an idle notification — so the orchestrator has to re-prompt it for
work that is already done. For read-only agents (reviewer, researcher) this is worse: they write no
files, so the un-sent message was the entire output of the run.

- The three `astrail-*` agent definitions now carry an explicit "HOW TO DELIVER" block. Keep it.
- **When dispatching a non-`astrail-*` agent** (`general-purpose`, `Explore`, `Plan`, …) you cannot
  edit its definition — put the instruction in the dispatch prompt: *"When done, call SendMessage
  to `main` with your report; plain output is not delivered."*
- **Diagnosing an idle agent:** check for the artifact first (a commit, a written file) before
  assuming failure. Implementers usually did the work; only the handoff dropped. Read-only agents
  have no artifact — re-prompt them, and ask for partial results if they did not finish.

## Model selection (per subagent-driven-development)

**Always specify the model explicitly when dispatching a subagent** — an omitted model inherits the
session's (often the most expensive).

Current tiering (**revised 2026-07-19**; supersedes the earlier opus-implements/opus-final-review split):

| Step | Model | Why |
|---|---|---|
| Plan (step 2) + reviewing a large merged diff that feeds a plan | **fable** | Highest-leverage thinking. Quota-limited — batch many issues into ONE plan pass rather than one pass per issue. |
| Implement (step 4, `astrail-developer`) | **opus** | Plentiful relative to fable; strong at faithful transcription-from-plan + TDD. |
| Per-task review gate (step 4, `astrail-reviewer`) | **sonnet** | ~7+ passes per arc. Never spend fable here — it exhausts the quota before step 5. |
| Final whole-branch review (step 5) | **fable** | The single review with the most to catch. Fable replaces opus for this pass. |
| Research (step 1) | **sonnet** | Read-only fan-out; cheap. |
| Cross-model outside voice (steps 3 + 6) | **`gpt-5.6-sol`** via Codex | Different-vendor blind spots. Call `codex exec -m gpt-5.6-sol` directly (NOT the shared runtime — it hangs on long reviews); raise `-c model_reasoning_effort="high"` for reviews, since the user's `~/.codex/config.toml` defaults to `low`. |

**Fable budget discipline:** roughly 3 fable passes per arc (plan, merged-diff review if any, final review).
If an arc needs more, batch harder — merge related issues into one plan — rather than raising the count.

## Why this loop (evidence)

Every Phase-1 arc shipped through it; the cross-model gate (step 3 Codex on the plan, step 6 Codex on the
code) has repeatedly found real defects that a single model — even opus, even adversarial — did not. The
cost is a few extra subagent passes; the payoff is bugs caught before merge instead of in production.
