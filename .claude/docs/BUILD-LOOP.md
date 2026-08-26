# Standard Feature Build Loop (Astrail backend)

> **The mandatory end-to-end workflow for building ANY backend feature.** Read this before you start a
> feature — planning OR implementing. It is the loop that shipped every Phase-1 backend arc (runtime
> spine → persistence → the enrich agents → latency → mem0 memory), and it exists for **teammate
> alignment**: shared review artifacts, one board as source of truth, a consistent workflow everyone
> follows. **Do not shortcut it to save time.** Feasible-first still governs *scope* within each step
> (ship the smallest working whole, defer polish behind a trigger); this governs *process*.

Trigger: the user says "build X" / "implement X" / "add feature Y", or you're about to plan or code any
backend change beyond a trivial one-line fix. When in doubt, follow the loop.

## Delegation surface (check this before step 1)

```bash
test "${HERDR_ENV:-}" = 1
```

**Passes → Herdr is the default** for **direct** Codex dispatch and for long or parallel work the
user should be able to watch. Read `.claude/docs/HERDR.md` before dispatching. **The gstack review
skills are the exception:** `/review`, `/autoplan` and every `/plan-*-review` spawn their own Codex
and are run as-is. Each prints a `CODEX_MODE:` line — `ready` means it already did the cross-model
pass (dispatching your own on top double-spawns); anything else means it skipped, and you owe one
from a **differing-vendor** pane. See steps 3 and 6.
**Fails → say so, then use the documented fallbacks** (`codex exec` for Codex, Task subagents as
below). Per-task review gates (step 4) and research (step 1) stay on **Task subagents** either way —
they run 7+ times an arc and depend on the per-dispatch model tiering in the table at the end of
this file.

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
   report teammates read). **It already runs the Codex outside voice itself** — it probes and prints
   `CODEX_MODE:` before deciding. **Read that line; it tells you whether you still owe a cross-model pass:**

   - `CODEX_MODE: ready` → gstack's own `codex exec` **is** the outside voice. **Do not dispatch a second
     one** — that is a double spawn on the same plan, paying twice for one opinion.
   - `under_codex` / `not_installed` / `not_authed` / `model_unusable` / `disabled` → gstack **skipped** its
     cross-model pass. You still owe one. **Supply it via Herdr when `HERDR_ENV=1`** (`.claude/docs/HERDR.md`),
     targeting a pane of a **different vendor than the agent doing the planning** — note `under_codex` means
     the main agent *is* Codex, so that pass needs a **Claude** pane, not a Codex one.
   - No differing-vendor pane and no Herdr → **say plainly that cross-model coverage is unavailable.**
     Do not mark the plan reviewed on same-vendor review alone; an unreviewed plan you know about beats one
     you believe was checked.

   Fold every blocking finding into the plan file. A plan is not "ready" until it
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

   **`/review` spawns its own Codex** (it probes the `codex` CLI, checks auth, and prints `CODEX_MODE:`) —
   so **Herdr does not transport this pass; you cannot route it through a pane.** Run `/review` as-is,
   then apply the same `CODEX_MODE` rule as step 3:

   - `ready` → `/review`'s own Codex is the cross-model pass. Done.
   - anything else (notably **`under_codex`**, i.e. the main agent is Codex) → `/review` **silently
     skipped** the cross-model pass, and the step's whole value with it. Supply it yourself: a Herdr
     pane of a **different vendor** (from a Codex host that means a **Claude** pane), or say plainly
     that cross-model coverage is unavailable for this diff. **Do not report step 6 as done on a
     `/review` run that skipped its Codex** — that is the failure mode this step exists to prevent.

   **Why it works, and how to prompt it (learned 2026-07-20 — it returned DO-NOT-MERGE on two arcs that
   three Claude reviewers had already passed).** The value is not extra reasoning depth. Every Claude pass
   reviews **the change**; the defects Codex found lived in the relationship between the change and
   **what is already deployed** — a different question, which a reviewer only asks if you make it part of
   the review surface. On Arc B it caught that the PR's own merge instruction would have taken production
   down: the migration changes the raised SQLSTATE from `P0001` to `AS4xx`, and `dev`'s running code
   matches `P0001`, so *both* orderings return 500. Three prior reviewers read the diff and agreed with it.

   So **put the deployment reality in the prompt**, not just the diff: what is running right now, how code
   and schema ship (separately, here), what the rollback does, and any scope limit you have already
   accepted — then ask explicitly for consequences *beyond* that limit. Codex correctly found a case that
   went past a boundary I told it was deliberate. Also tell it to say plainly when it finds nothing at a
   severity; every agent this session found at least one thing the previous reviewer had over- or
   understated, and "nothing here" is more useful than invented filler.

7. **Live-verify.** A real smoke against the live stack (`backend/scripts/live_run.py` or a focused script) —
   prove the feature works end-to-end, not just in unit tests. For **UI / auth / SSE / Mapbox / full-flow**
   changes, gstack **`/qa`** evidence is required. Credit-spending or live-DB runs: get the user's go first.

8. **Ship.** Open a PR to `dev` with the review trail + live evidence in the body; merge; fast-forward `shaun`
   to `dev`; delete the feature branch (local + remote). **Commit / push / PR only when the user asks.**

9. **Record.** Update the repo docs the change affects (`.claude/docs/ARCHITECTURE.md`, `docs/PRD.md`, this
   file, CLAUDE.md), **EMDEE** (Zhi Hao's SHARED vault — the `DECISIONS LOG` entry + a `ROADMAPS` status
   snapshot; **never the local mirror**; the shared vault IS writable despite INFO.md's blanket note), and
   memory. Hand **Codex** the board-card update (Codex owns GitHub Project mutations).

10. **Release — a SEPARATE gated process, not the tail of this loop.** Steps 0–9 end at `dev`. Production
    is owned by the **`astrail-release`** skill: it loads the EMDEE **RELEASE SOP** + **Launch
    Pre-Checklist** live, then enforces the pre-flight gate, the golden order
    (**migrations → backend → frontend → flags**), the Shaun/ZH owner split, the flag choreography, and
    rollback. Invoke it explicitly. **Never deploy as an unannounced continuation of a feature arc** — the
    reason schema and code ship decoupled here is precisely that they are *decided* separately.

    If the arc lands **dark** (merged and deployed but flag-gated) or needs the other owner's surface,
    step 10 is not "later" — write the `docs/deploy/YYYY-MM-DD-<topic>-handoff.md` **now**, while you
    still know what is true. Dark deploys rot silently; a handoff doc is the only thing that makes one
    recoverable weeks later.

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

## Two traps that produce confusing-but-harmless-looking states (learned 2026-07-19/20)

**An editor can reformat files you edit.** No formatter hook exists in any `settings.json`, but
VS Code's format-on-save applies **Prettier defaults** (double quotes, semicolons) to frontend
files that are open in the editor — against this repo's single-quote / no-semicolon style. A
frontend Edit came back with 39/-27 of pure style churn. Symptoms: a diff far larger than the
change you made. Workaround: revert, then write frontend files via `Bash` heredoc/`python3`
rather than `Edit`, and check `git diff --stat` before committing any frontend change.

**Clear `__pycache__` when you fault-inject an imported module.** CPython invalidates a `.pyc`
by comparing the source's mtime **and size**, and restoring a file from a backup can leave the
cache looking current — so the interpreter keeps running the FAULTED bytecode while
`git status` reports a clean tree and the source reads correctly. Every signal says fine; tests
fail anyway. Add `find . -name __pycache__ -type d -not -path "./.venv/*" -exec rm -rf {} +` to
the restore step.

**The eval anchor is a pytest assertion, not the CLI's headline number.**
`uv run python -m evals.run_eval` prints `mean_intra_day_travel_m = 8163.7`; the frozen `#16`
anchor is `6229.0`, asserted on a fixture case inside `evals/test_run_eval.py:82`. They are
different subjects. **`uv run pytest evals/ -q` is the gate** — do not chase the CLI number as a
regression.

## NEVER `git add -A` while a subagent is working (learned 2026-07-19, the hard way)

Subagents share the orchestrator's working tree. An orchestrator running `git add -A && git commit`
to land its own docs **sweeps the subagent's in-progress source files into that commit** — the
developer then finds its work already committed under someone else's message.

**Rule: stage explicit paths, always.**

```bash
git add docs/superpowers/reviews/my-doc.md          # yes
git add -A                                           # NO, not while any subagent is live
```

If it happens anyway, the repair that preserves everyone's authorship is:
`git reset <last-good>` → `git commit -C <bad-sha>` with only the intended paths staged (keeps the
original message/author/date) → let the subagent commit its own work separately. Verify with
`git diff <bad-sha> HEAD` — **empty means byte-identical, only the commit boundary moved.**
Nothing is lost; the old SHA stays in the reflog.

Related: check `git status --short` before committing. A file you did not touch appearing there is
the tell that a subagent is mid-write.

## Calling Codex — Herdr first, `codex exec` as the fallback

**Default (2026-08-26): dispatch Codex through Herdr.** This governs Codex calls **you** make
directly. It does **not** apply to gstack skills that run their own Codex internally — `/review`,
`/autoplan`, and every `/plan-*-review` — run those as-is and read their `CODEX_MODE:` line. When `test "${HERDR_ENV:-}" = 1` passes, use a named pane and skip
this entire section — none of the traps below can occur, and the user can watch the review:

```bash
herdr agent list                                    # read pane_id, agent (the VENDOR), agent_status
herdr agent rename <pane-id> <name>                 # once, for a stable target; name the ROLE, not the vendor
herdr agent prompt <name> "<prompt>" --wait --timeout 1800000
herdr agent read <name> --source recent-unwrapped --lines 200
```

Choose the pane by its `agent` (vendor) field — it must differ from the agent doing the asking, or it
is not a cross-model pass. Do not hardcode a target called `codex`.

Full contract, including the alternate-screen read fallback and the safety rules:
`.claude/docs/HERDR.md`. **Everything below is the no-Herdr fallback path.** Keep it — CI, the other
owner's machine, and plain terminals still need it.

### Fallback: `codex exec` without hanging (learned 2026-07-19 — cost ~20 min twice)

`codex exec "<prompt>"` **hangs** when stdin is a non-TTY pipe with nothing written to it: it
prints `Reading additional input from stdin...` and waits forever. This is NOT the shared-runtime
hang — it happens to direct `codex exec` too, and it is easy to misattribute. Always redirect:

```bash
timeout 1500 codex exec -m gpt-5.6-sol -c model_reasoning_effort="high" \
  --sandbox read-only --skip-git-repo-check "<prompt>" \
  < /dev/null > /path/to/out.txt 2>&1
```

- `< /dev/null` is the fix — immediate EOF, so Codex uses the prompt argument.
- Redirect to a **file**; do NOT pipe to `tail`/`head` (they buffer to completion, so you get no
  incremental output and cannot tell progress from a hang).
- `-c model_reasoning_effort="high"` matters: the user's `~/.codex/config.toml` defaults to `low`,
  which is too weak for a plan or migration review.
- **Exit code 0 does not mean it did the work.** A hung-then-killed run exits 0 with an empty or
  header-only file. Check the output, not the status.

**Under Herdr, none of this applies — `herdr agent list` reports only Herdr-managed agents**, so
there is nothing to grep for and nothing of the user's to misidentify. The rest of this subsection
is for the fallback path only.

**Do NOT zombie-check with `ps aux | grep -i codex | wc -l`.** That pattern counts the user's
running **ChatGPT.app desktop application** (~14 helper processes: renderers, GPU, network,
Sparkle updater, computer-use service) plus the VS Code ChatGPT extension. On 2026-07-20 it
reported "20 codex processes" against **zero** orchestration leftovers — and the obvious
remediation would have been to kill the user's editor and chat app. Match what *you* actually
spawn:

```bash
ps -eo pid,etime,command | grep "[c]odex exec" | grep -v "grep"
```

Anything from `/Applications/ChatGPT.app/`, `.vscode/extensions/`, or `codex app-server` belongs
to the user's environment — **never kill it.** A genuine leftover is a `codex exec` whose elapsed
time exceeds the `timeout` you wrapped it in.

## Subagent result delivery (learned 2026-07-19 — cost ~5 wasted round-trips in one session)

**This section is about Task-tool subagents only.** An agent running in a **Herdr pane** has no
handoff step and therefore none of this failure mode — you read its output directly with
`herdr agent read <name> --source recent-unwrapped`. That is a large part of why Herdr is the
default for the Codex passes and for any long delegated task.

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

## Tests that cannot fail — the six ways found so far (learned 2026-07-20, all in one session)

Fault injection is already a non-negotiable above. This is *where to point it*: six real cases from
one session where a test looked like coverage and asserted nothing. **None were found by reading
tests.** Every one was found by deleting the production code and watching what failed to redden.

1. **A closure constructed but never invoked.** `run_organize_job`'s default Apify seam was built by
   one test and *called* by none. Defining a nested function resolves none of the names in its body —
   lookup happens at call time — so a `NameError` sat in the production path while 727 tests passed.
2. **A fixture already in the asserted order.** The SSE cursor test seeded events `1, 2` and asserted
   `1, 2`, so it passed with `.order("sequence")` deleted outright. **If the fixture's natural state
   satisfies the assertion, the assertion tests nothing.**
3. **An assertion that runs before the mutation it should catch.** A guard checked the stored value
   *before* calling the function that would have corrupted it.
4. **A fake whose method is a no-op.** `_Table.order` was `return self`. Three production call sites
   relied on `.order()`, and no test could ever have detected its removal. Fakes must implement the
   real interface — a partial fake plus a `hasattr` fork in production is the same bug wearing a hat.
5. **A React unmount that proves nothing.** A full-tree unmount "proving" a provider outlives its
   consumer passes vacuously, because React destroys the parent first. Model the actual route change.
   (Same shape: `rerender` reconciles the same element and never re-runs the effect — use distinct keys.)
6. **A fixture missing a field, so an earlier gate short-circuits.** A country-predicate test seeded
   its row with no lat/lng, so the distance gate skipped it and the predicate under test never ran.
   It passed with the country check deleted. This one had been in the repo for a long time.

7. **A disjunctive assertion, so no single guard is attributable** (learned 2026-08-02, the mem0
   settings arc — this one fired FOUR times in one arc, twice inside a plan that quotes this very
   section). `test_list_memory_facts_survives_malformed_payloads` asserted
   `status in ("ok", "unavailable")` and `facts == []`. Two independent guards — the blanket
   `except` and the per-row `isinstance(m, dict)` filter — each produce one of those outcomes on
   their own, so deleting **either** left the test green. It genuinely proved "never 500s"; it could
   not prove *which mechanism* delivered that. Same shape in `mem0_client`: a success-path
   `_init_failed = False` was unobservable because `mem0_status()` short-circuits on
   `_client is not None` before ever reading the flag, so removing the line broke nothing.
   The fix is never a stricter assertion — it is choosing an **outcome only the guard under test can
   produce**: assert a valid row *survives beside* garbage rows (the `except` path returns `[]`, so
   it cannot fake that), and assert the flag across a failure→recovery sequence (the only path that
   reads it).

**The rule that catches all seven:** before trusting any test, state *what specifically makes it red
when the guard is removed* — then delete the guard and prove it. When several guards can yield the
same safe result (defense in depth), you need one test per guard whose expected value is
**unreachable from the others**. And when a fault genuinely cannot be made to redden alone — as with
an outer `try` that only matters once the inner guards are also gone — say so explicitly in the plan
and prove it reddens *in combination*, rather than deleting the guard as "dead code."
Clear `__pycache__` first
(`find . -name __pycache__ -type d -not -path "./.venv/*" -exec rm -rf {} +`); restoring a file can
leave stale bytecode so every signal reads clean while the interpreter runs faulted code.

**And check whether the instrument itself can see the change.** A static `mapbox-gl` import put 1.7MB
into a shared chunk and `next build`'s size table reported every route as *unchanged*; it took
diffing `app-build-manifest.json` to see it. `/health` returns green against the wrong schema.
`supabase test db` cannot reach `supabase/migrations/rollback/` at all, so a rollback test must run
host-side — and testing a *copy* of the script is how a divergent script ships green.

## Look for absences, not just defects (learned 2026-07-20)

Two of the session's most valuable findings were things that did not exist, and **no code review can
find those** — an absent file has no line number, fails no test, and appears in no diff. Both came
from reading the spec and asking *which described behaviours have no host surface*:

- The app had **no `error.tsx` and no `not-found.tsx` anywhere**, so Next.js was serving stock error
  screens — found by looking for where `DESIGN-DRAFT.md` §7 said the mascot should appear.
- `TripDay.title/summary/weather_summary` — the **narrator and weather agents' output** — shipped in
  every bundle and rendered nowhere. The backend paid for narration on every run and discarded it.

So run one pass code-first (is what exists correct?) and one pass spec-first (does everything
described have somewhere to live?). They find different classes of defect.

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
| Cross-model outside voice (steps 3 + 6) | **Any vendor OTHER than the agent doing the asking** — from Claude that is Codex (`gpt-5.6-sol`); **from Codex it must be Claude** | Different-vendor blind spots — the *difference* is the point, not the brand. **First read the gstack skill's `CODEX_MODE:` line:** `ready` means it already ran the pass, so dispatch nothing. Only when it skipped do you owe one — **via Herdr when `HERDR_ENV=1`** (`.claude/docs/HERDR.md`), targeting a differing-vendor pane. **You cannot choose or verify a running pane's model from the CLI** — `herdr agent read` returns terminal output, not model metadata (a footer line often shows it, but that is the agent's own rendering, not a guarantee). To pin the model, start the pane yourself with native flags after `--`; otherwise ask the user what the pane is running. No-Herdr fallback, **and only from a non-Codex host**: `codex exec -m gpt-5.6-sol` directly (NOT the shared runtime — it hangs on long reviews), raising `-c model_reasoning_effort="high"`, since the user's `~/.codex/config.toml` defaults to `low`. From a Codex host with no Claude surface reachable, there is no valid fallback — **report that cross-model coverage is unavailable** rather than running Codex against itself. |

**Fable budget discipline:** roughly 3 fable passes per arc (plan, merged-diff review if any, final review).
If an arc needs more, batch harder — merge related issues into one plan — rather than raising the count.

## Why this loop (evidence)

Every Phase-1 arc shipped through it; the cross-model gate (step 3 Codex on the plan, step 6 Codex on the
code) has repeatedly found real defects that a single model — even opus, even adversarial — did not. The
cost is a few extra subagent passes; the payoff is bugs caught before merge instead of in production.
