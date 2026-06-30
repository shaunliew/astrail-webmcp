# Extractor Observability Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix two follow-ups surfaced during the manual-paste review: (1) the extractor's `web_search_calls=0` diagnostic — a counter bug, not hallucination; (2) harden the weak `test_import_capture_needs_no_keys` so it actually proves the import-keyless / no-SDK invariant.

**Architecture:** Both are small, isolated quality fixes. Task 1 corrects `_count_web_searches` in `genagents/place_extractor.py` to read the right field. Task 2 replaces an in-process module-reload test with a fresh-subprocess import test in `test_capture.py`. No production behavior changes — these only fix an observability counter and strengthen a test.

**Tech Stack:** Python 3.14, openai-agents **0.17.7**, openai **2.44.0**, pytest, stdlib `subprocess`.

**Grounded research (installed SDK, authoritative for our pinned version):**
- `agents.items.ToolCallItemTypes` (the `ToolCallItem.raw_item` union) **includes** `openai.types.responses.ResponseFunctionWebSearch`, whose `type` field is the literal **`"web_search_call"`**.
- A hosted `WebSearchTool` call therefore surfaces in `result.new_items` as a **`ToolCallItem`** (class name `"ToolCallItem"`) wrapping a `ResponseFunctionWebSearch` raw item.
- `agents.items.ToolSearchCallItem` is a **different, unrelated feature** (tool search; raw type `ResponseToolSearchCall`) — NOT web search.
- The current matcher (`"ToolSearch" in name` OR `"ToolCall" in name and "search" in name.lower()`) matches neither a real web-search `ToolCallItem` (no "search" in "toolcallitem") nor anything useful, so it always returns 0. The reliable signal is `raw_item.type == "web_search_call"`.

## Global Constraints

- **Offline default suite stays credential-free and green.** Both tasks' tests are offline (stub objects / a subprocess that only imports). No API key, no network, no live OpenAI call. The `#16` eval must stay green and untouched.
- **No production behavior change.** `extract_places` still returns the same `PlaceResult`s; only the stderr diagnostic count is corrected. `capture.py` is not modified by Task 2 (only its test).
- **Import-time invariant (the thing Task 2 now actually tests):** importing `capture` / `scrape.manual_input` needs no key, imports no Agents SDK (`agents`) and no `openai` at import time, and makes no network call.
- **Coding style:** PEP 8, type annotations, small focused changes, explicit over clever.

---

### Task 1: Fix the `web_search_calls` counter

**Files:**
- Modify: `backend/genagents/place_extractor.py` (`_count_web_searches`)
- Test: `backend/genagents/test_place_extractor.py`

**Interfaces:**
- Consumes: a run result object with a `new_items` list whose items have a `raw_item` (object with `.type`, or a `dict` with `"type"`).
- Produces: `_count_web_searches(result) -> int` counting items whose `raw_item.type == "web_search_call"`. Unchanged signature; used by `extract_places`'s stderr diagnostic.

- [ ] **Step 1: Write the failing tests**

Add to `backend/genagents/test_place_extractor.py` (import `_count_web_searches` from the module; add near the other tests):

```python
from genagents.place_extractor import _count_web_searches


class _Raw:
    def __init__(self, type_):
        self.type = type_


class _Item:
    def __init__(self, raw):
        self.raw_item = raw


class _Result:
    def __init__(self, items):
        self.new_items = items


def test_count_web_searches_counts_web_search_call_raw_items():
    # a hosted WebSearchTool call is a ToolCallItem whose raw_item.type == "web_search_call"
    result = _Result([
        _Item(_Raw("web_search_call")),
        _Item(_Raw("function_call")),          # the extractor's own tool call — not a search
        _Item(_Raw("web_search_call")),
        _Item({"type": "web_search_call"}),    # raw_item can be a dict (union allows it)
        _Item(_Raw("reasoning")),
        _Item(None),                           # message/other items have no raw_item.type
    ])
    assert _count_web_searches(result) == 3


def test_count_web_searches_ignores_unrelated_tool_search_items():
    # ToolSearchCallItem (the separate tool-search feature) must NOT be counted
    result = _Result([_Item(_Raw("tool_search_call")), _Item(_Raw("file_search_call"))])
    assert _count_web_searches(result) == 0


def test_count_web_searches_no_new_items_returns_zero():
    class _Bare:
        pass
    assert _count_web_searches(_Bare()) == 0          # stub result, no new_items attr
    assert _count_web_searches(_Result([])) == 0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest genagents/test_place_extractor.py -q -k count_web_searches`
Expected: the first test FAILS (current matcher returns 0 for `web_search_call` raw items, so `0 == 3` fails). The unrelated/empty tests pass.

- [ ] **Step 3: Fix `_count_web_searches`**

In `backend/genagents/place_extractor.py`, replace the existing `_count_web_searches` with:

```python
def _count_web_searches(result) -> int:
    """Count hosted WebSearchTool calls in a run result.

    In openai-agents 0.17.x a web search surfaces as a `ToolCallItem` whose `raw_item`
    is an `openai.types.responses.ResponseFunctionWebSearch` with `type == "web_search_call"`
    — NOT the separate `ToolSearchCallItem` (an unrelated tool-search feature). Matching the
    wrapper class name therefore misses every real search; match the raw item's `type`
    literal instead, tolerating a dict raw_item (the SDK union allows it). Defensive: a
    fake/stub result with no `new_items` returns 0, keeping unit tests offline.
    """
    items = getattr(result, "new_items", None) or []
    count = 0
    for it in items:
        raw = getattr(it, "raw_item", None)
        raw_type = raw.get("type") if isinstance(raw, dict) else getattr(raw, "type", None)
        if raw_type == "web_search_call":
            count += 1
    return count
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest genagents/test_place_extractor.py -q`
Expected: PASS — the 3 new counter tests plus all pre-existing extractor tests (the injected-runner stub results have no `new_items`, so they still report 0 and pass).

- [ ] **Step 5: Commit**

```bash
cd backend && git add genagents/place_extractor.py genagents/test_place_extractor.py
git commit -m "fix(extractor): count web_search_call raw items (web_search_calls=0 was a counter bug)"
```

---

### Task 2: Harden the import-keyless invariant test

**Files:**
- Modify: `backend/test_capture.py` (`test_import_capture_needs_no_keys`)

**Interfaces:**
- Consumes: `subprocess`, `sys`, `os`, `pathlib.Path` (stdlib).
- Produces: a test that spawns a FRESH interpreter importing `capture` + `scrape.manual_input` with the three secret env vars stripped, asserting exit 0 AND that neither `agents` nor `openai` was imported at import time.

- [ ] **Step 1: Write the replacement test**

In `backend/test_capture.py`, ensure `import os`, `import sys`, `import subprocess`, and `from pathlib import Path` are present at the top (add any that are missing). Replace the existing `test_import_capture_needs_no_keys` with:

```python
def test_import_capture_is_keyless_and_sdk_free_in_fresh_interpreter():
    # Stronger than an in-process reload (which reuses cached transitive modules):
    # spawn a FRESH interpreter with the secret env vars stripped, and assert that
    # importing capture (a) needs no key and (b) pulls in neither the Agents SDK nor
    # openai at import time — both must stay lazily imported inside main()/extract_places.
    code = (
        "import sys; import capture, scrape.manual_input; "
        "assert 'agents' not in sys.modules, 'Agents SDK imported at import time'; "
        "assert 'openai' not in sys.modules, 'openai imported at import time'; "
        "print('IMPORT_OK')"
    )
    env = {k: v for k, v in os.environ.items()
           if k not in ("OPENAI_API_KEY", "APIFY_TOKEN", "MAPBOX_SECRET_TOKEN")}
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(Path(__file__).parent),   # backend/ — where capture.py lives
        env=env, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, f"fresh import failed: {result.stderr}"
    assert "IMPORT_OK" in result.stdout
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd backend && uv run pytest test_capture.py -q -k fresh_interpreter`
Expected: PASS. (If it fails asserting `agents`/`openai` was imported, that is a REAL regression of the import-time invariant — investigate the offending top-level import rather than weakening the test.)

- [ ] **Step 3: Run the whole capture test file (no regressions)**

Run: `cd backend && uv run pytest test_capture.py -q`
Expected: PASS — the renamed/hardened test plus all others (one test was replaced, not added, so the count stays the same).

- [ ] **Step 4: Commit**

```bash
cd backend && git add test_capture.py
git commit -m "test(capture): prove import-keyless + no-SDK invariant in a fresh interpreter"
```

---

## Verification (after both tasks)

```bash
cd backend && uv run pytest -q                                   # full offline suite, 1 live skip
cd backend && uv run python -m evals.run_eval --subject baseline # OVERALL: PASS
cd backend && uv run python -m evals.run_eval --subject pipeline # OVERALL: PASS
```

Optional live confirmation of the counter fix (hits OpenAI; human-run only) — re-run a capture and confirm the stderr line now shows `web_search_calls=N` (N>0) instead of 0:

```bash
cd backend && uv run python -m capture --reels "https://www.instagram.com/reel/DXwcVVliX3B/" --out-dir captures
```

## NOT in scope / follow-up

- **CLAUDE.md correction:** the "Hard-Won Lessons" note that `WebSearchTool` calls appear as `ToolSearchCallItem` is stale for openai-agents 0.17.x (web search = `ToolCallItem` + `raw_item.type=="web_search_call"`; `ToolSearchCallItem` is a different feature). Worth a docs fix, but CLAUDE.md edits are out of scope for this code task — flag to Shaun.
- No change to the extractor's actual behavior, prompt, or model config — `tool_choice="required"` already forces the search; only the count display was wrong.

## Rollback / risk

- **Blast radius:** one function body in `genagents/place_extractor.py` + test additions; one test rewrite in `test_capture.py`. No production behavior change. Revert = drop the two commits.
- **Risk:** Very low. Task 1 is a pure counting fix covered by offline stub tests. Task 2 only strengthens a test; if the hardened test fails it has caught a real invariant regression, which is the point.
