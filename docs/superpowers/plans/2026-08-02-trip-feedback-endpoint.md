# Trip Feedback Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `POST /trips/{trip_id}/feedback` so the 2026-08-08 beta has an instrument for its primary success metric (PRD:86 — "real users … provide feedback").

**Architecture:** One new route in `backend/main.py` following the established bare-`@app.post` convention (there is no routers package). Auth → rate limit → app-code owner check on `trips` → single append-only INSERT into the already-deployed `feedback` table. Scope is trip-level only (`artifact_type='trip'`, `artifact_id=NULL`); the table and its RLS already accept the other five artifact types, so artifact-level feedback is purely additive later with no migration.

**Tech Stack:** FastAPI · Pydantic v2 · supabase-py v2 `AsyncClient` (service_role) · slowapi · pytest + httpx `ASGITransport`.

## Global Constraints

- **No migration.** The `feedback` table already exists (`supabase/migrations/20260702012806_generated_trip_outputs.sql:85`) and was verified live in deployed Supabase on 2026-08-02 (read-only probe: `HTTP 200`, 0 rows). Do not write a migration file.
- **Guardrail #5 — auth on every endpoint.** Use `get_current_user_id_stashed`; never accept `user_id` from the body or query.
- **Guardrail #6 — owner check in APP CODE.** `service_role` bypasses RLS (`backend/pipeline/persist.py:515`), so the `feedback_insert_own_trip` policy is **not** the enforcement path here. The route must itself verify the trip belongs to the caller.
- **404, never 403.** Every existing owner check in this repo (`main.py:470-472`, `organizer.py:181-185`) makes "trip absent" and "trip not yours" indistinguishable. Match it exactly — but note `main.py:470` only *intends* this and currently 500s on an absent trip, which Task 2 fixes. Copy the corrected form, not the deployed one.
- **Guardrail #4 — schema parity.** Every new Pydantic model gets a snake_case 1:1 mirror in `frontend/lib/trip/backend-types.ts` in the same PR. No DB side needed (table exists).
- **Eval safety.** This arc touches no pipeline code. `uv run pytest evals/ -q` must stay green with the frozen `#16` anchor `mean_intra_day_travel_m = 6229.0` unmoved.
- **Style.** `Literal[...]` mirrors a Postgres CHECK constraint; plain `str` where no CHECK exists (`backend/api/schemas.py:35` states this rule). Free text gets an explicit `max_length`.
- **Test command:** `cd backend && uv run pytest` (scoped: `uv run pytest test_main.py -q`).
- **Worktree:** all work happens in `/Users/shaunliew/Documents/astrail-worktrees/trip-feedback` on branch `feat/trip-feedback`. **Never** touch `backend/telegram_ingest/` (a concurrent session owns it). **Never** `git add -A` — stage explicit paths only.

## Design decisions (locked in the 2026-08-02 interview — do not relitigate)

| Decision | Choice | Why |
|---|---|---|
| Payload shape | **Generic**: any of the 5 `feedback_type` values + optional `comment` | Zhi Hao's UI does not exist yet; stars OR thumbs OR a note ship without a second backend PR. |
| Resubmission | **Append-only, no dedup** | Table has no unique constraint (verified); a 2-then-5 rating is signal, not noise. Analytics take latest-per-user via the existing `feedback_user_id_created_at_idx`. |
| PRD:1035 metadata (`source_type`, `generation_stage`, `preference_source`) | **Leave NULL** | They describe how an *artifact* was generated; storing unverified client strings would be analytics you cannot trust. Deferred to artifact-level. |
| Trip state gate | **Any state the caller owns** | Feedback on a FAILED trip is the most valuable beta signal. Avoids coupling to the job-status vocabulary. |
| Rate limit | **Reuse `BURST_LIMIT`** (`3/minute`, env `BURST_LIMIT`) | Rating a trip is ONE request; slowapi buckets per-endpoint so it does not consume `/generate-trip` budget. Zero new config. |

## Non-goals (each with its concrete trigger)

- **Artifact-level feedback** (place / transport_leg / restaurant_suggestion / hotel_suggestion / generation_event). RLS at `20260702134839_artifact_feedback_weather_contracts.sql:32-100` already validates all five against their parent tables. *Trigger: Zhi Hao's UI needs per-place thumbs.*
- **`GET /trips/{trip_id}/feedback` readback.** Not in the PRD endpoint list (PRD:810-820). *Trigger: the UI must show a previously submitted rating.*
- **Dedup / idempotency key.** *Trigger: duplicate rows measurably pollute adoption analytics.*
- **Postgres daily quota layer.** *Trigger: observed abuse.*
- **Aggregate/admin analytics endpoint.** *Trigger: someone needs the beta numbers in-app rather than via the Supabase dashboard.*

## TODO for whoever builds `DELETE /trips/:tripId` (plan-eng-review finding A1)

`feedback.trip_id` is `references public.trips(id) **on delete cascade**`
(`supabase/migrations/20260702012806_generated_trip_outputs.sql:86`). `DELETE /trips/:tripId` is
required by PRD:816 and **is not built yet** (verified: no `@app.delete` in `backend/main.py`).

The moment it ships, a user deleting a trip silently deletes all its feedback — erasing the exact
adoption signal PRD:86 makes the primary beta success measure. Nothing errors; the numbers are
just quietly low.

Options for that arc, in preference order: (1) soft-delete trips instead of hard-deleting;
(2) migrate `feedback` to keep a denormalized trip snapshot and a nullable `trip_id`. Option (2)
cannot use `ON DELETE SET NULL` as-is because `trip_id` is `NOT NULL`.

Deliberately **not** fixed here: it needs a migration, and this arc is migration-free by design.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `backend/api/schemas.py` | `TripFeedbackRequest`, `TripFeedback`, `TripFeedbackResponse` + cross-field validator | Modify (append) |
| `backend/test_main.py` | **Task 2:** make `_Table`/`_Client` faithful to postgrest. **Task 3:** route tests | Modify |
| `backend/main.py` | **Task 2:** fix the `main.py:470` stream owner check. **Task 3:** the feedback route | Modify |
| `frontend/lib/trip/backend-types.ts` | snake_case 1:1 TS mirror (guardrail #4) | Modify (append) |
| `backend/api/test_schemas.py` | Validator unit tests | Modify (append) |
| `.claude/docs/ARCHITECTURE.md` | Endpoint list entry | Modify |

**No new files.** `main.py` is 496 lines and the repo's single-file route convention is explicit; adding one route keeps it well under the 800-line ceiling. Tests go in `test_main.py` because the full in-memory postgrest fake (`_Client`/`_Table`) lives there — a new test file would have to import it across modules or re-hand-roll a partial fake, which is the exact failure mode `.claude/docs/BUILD-LOOP.md:203` warns about.

---

### Task 1: Request/response schemas + TS mirror

**Files:**
- Modify: `backend/api/schemas.py` (append at end of file)
- Modify: `frontend/lib/trip/backend-types.ts` (append at end of file)
- Test: `backend/api/test_schemas.py` (append at end of file)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, for **Task 3** (Task 2 is independent of this task and may run in either order,
  though the numbering assumes 1 → 2 → 3):
  - `TripFeedbackRequest(feedback_type: Literal["rating","thumbs_up","thumbs_down","correction","free_text"], rating: int | None, comment: str | None)`
  - `TripFeedback(id: str, trip_id: str, artifact_type: Literal["trip"], feedback_type: Literal["rating","thumbs_up","thumbs_down","correction","free_text"], rating: int | None, comment: str | None)`
    — `feedback_type` is a `Literal`, matching Step 3's code block. (This summary previously said
    `str`; the code block always said `Literal`. Corrected after the Task 1 review flagged the
    mismatch, so Task 3 is not misled about what it can pass.)
  - `TripFeedbackResponse(feedback: TripFeedback)`

**Why `created_at` is deliberately NOT in the response:** the `_Table` fake's `insert` (`backend/test_main.py:83-86`) synthesises only `{"id": ..., **row}` — it does not apply Postgres column defaults. A response field populated by `default now()` would therefore be present in production and absent in every test, so no test could ever detect it breaking. Omitting it removes the fake/real divergence entirely, and the client already knows when it posted. *Trigger to add it: a consumer needs server time rather than client time.*

- [ ] **Step 1: Write the failing validator tests**

Append to `backend/api/test_schemas.py`:

```python
import pytest
from pydantic import ValidationError

from api.schemas import TripFeedbackRequest


def test_rating_feedback_requires_a_rating():
    with pytest.raises(ValidationError, match="rating is required"):
        TripFeedbackRequest(feedback_type="rating")


def test_non_rating_feedback_rejects_a_rating():
    # A thumbs_up carrying rating=5 is ambiguous: the DB would store both and the
    # analytics query cannot tell which the user meant.
    with pytest.raises(ValidationError, match="rating is only valid"):
        TripFeedbackRequest(feedback_type="thumbs_up", rating=5)


@pytest.mark.parametrize("bad", [0, 6, -1])
def test_rating_outside_one_to_five_is_rejected(bad):
    # Mirrors the DB CHECK feedback_rating_range (rating >= 1 and rating <= 5).
    with pytest.raises(ValidationError):
        TripFeedbackRequest(feedback_type="rating", rating=bad)


@pytest.mark.parametrize("kind", ["free_text", "correction"])
def test_text_only_feedback_requires_a_comment(kind):
    # Without a comment these rows carry no information at all.
    with pytest.raises(ValidationError, match="comment is required"):
        TripFeedbackRequest(feedback_type=kind)


def test_unknown_feedback_type_is_rejected():
    # Mirrors the DB CHECK feedback_feedback_type_check.
    with pytest.raises(ValidationError):
        TripFeedbackRequest(feedback_type="five_stars")


def test_comment_longer_than_2000_chars_is_rejected():
    with pytest.raises(ValidationError):
        TripFeedbackRequest(feedback_type="free_text", comment="x" * 2001)


def test_comment_of_exactly_2000_chars_is_accepted():
    # Boundary: max_length is inclusive. Without this, changing le/lt goes unnoticed.
    assert len(TripFeedbackRequest(feedback_type="free_text", comment="x" * 2000).comment) == 2000


@pytest.mark.parametrize("blank", ["", "   ", "\n\t "])
def test_whitespace_only_comment_is_rejected_for_text_feedback(blank):
    # A bare truthiness check would let "   " through and store an empty-signal row.
    with pytest.raises(ValidationError, match="comment is required"):
        TripFeedbackRequest(feedback_type="free_text", comment=blank)


@pytest.mark.parametrize("sneaky", [True, "4", 5.0])
def test_rating_rejects_non_int_types(sneaky):
    # strict=True. Non-strict Pydantic would coerce True->1, "4"->4, 5.0->5 and silently
    # write a rating the user never gave.
    with pytest.raises(ValidationError):
        TripFeedbackRequest(feedback_type="rating", rating=sneaky)
```

**`strict=True` behaviour was verified on the installed Pydantic 2.13.4, through JSON parsing
(the path FastAPI actually uses), not just Python-object construction:**

| JSON body | Result |
|---|---|
| `{"rating": 4}` | accepted → `4` |
| `{"rating": "4"}` | **rejected** |
| `{"rating": true}` | **rejected** |
| `{"rating": 5.0}` | **rejected** |
| `rating` omitted | accepted → `None` |

So `strict=True` does not break the ordinary integer path from a JSON client — it only closes the
coercion holes.

```python
# (continuing backend/api/test_schemas.py)


def test_valid_shapes_are_accepted():
    assert TripFeedbackRequest(feedback_type="rating", rating=4).rating == 4
    assert TripFeedbackRequest(feedback_type="thumbs_up").rating is None
    assert TripFeedbackRequest(feedback_type="rating", rating=1, comment="ok").comment == "ok"
    assert TripFeedbackRequest(feedback_type="free_text", comment="too much walking")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest api/test_schemas.py -q`
Expected: collection FAILS with `ImportError: cannot import name 'TripFeedbackRequest' from 'api.schemas'`. The whole module fails to import, so no test in the file runs — that is the expected RED here, not individual assertion failures.

- [ ] **Step 3: Add the schemas**

Append to `backend/api/schemas.py`:

```python
class TripFeedbackRequest(BaseModel):
    """POST /trips/{trip_id}/feedback body -- trip-level feedback only.

    `artifact_type`/`artifact_id` are deliberately NOT accepted from the client: the
    route hardcodes ('trip', None). Accepting them would let a caller aim feedback at
    another trip's artifact, and service_role bypasses the RLS policy that would
    otherwise validate the artifact against its parent table (persist.py:515).

    Literal[...] on feedback_type mirrors the DB CHECK feedback_feedback_type_check;
    ge/le on rating mirrors feedback_rating_range. Keeping them in lockstep means a
    bad payload is a clean 422 instead of a Postgres constraint violation surfacing
    as a 500.
    """
    feedback_type: Literal["rating", "thumbs_up", "thumbs_down", "correction", "free_text"]
    # strict=True (Codex MINOR): non-strict Pydantic coerces JSON `true` -> 1, `"4"` -> 4 and
    # `5.0` -> 5. A boolean silently becoming a 1-star rating is analytics poison in the exact
    # dataset this endpoint exists to produce.
    rating: int | None = Field(default=None, ge=1, le=5, strict=True)
    comment: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def check_rating_matches_feedback_type(self):
        if self.feedback_type == "rating" and self.rating is None:
            raise ValueError("rating is required when feedback_type is 'rating'")
        if self.feedback_type != "rating" and self.rating is not None:
            raise ValueError("rating is only valid when feedback_type is 'rating'")
        # .strip() (Codex MINOR): a whitespace-only comment passes a bare truthiness check and
        # stores a row with no information -- the same defect as an empty comment.
        if self.feedback_type in ("free_text", "correction") and not (self.comment or "").strip():
            raise ValueError(f"comment is required when feedback_type is '{self.feedback_type}'")
        return self


class TripFeedback(BaseModel):
    """One stored feedback row, as echoed back to the client.

    No created_at: the in-memory test fake does not apply Postgres column defaults, so
    a default-populated field would be untestable (present in prod, absent in tests).
    """
    id: str
    trip_id: str
    artifact_type: Literal["trip"] = "trip"
    feedback_type: Literal["rating", "thumbs_up", "thumbs_down", "correction", "free_text"]
    rating: int | None = None
    comment: str | None = None


class TripFeedbackResponse(BaseModel):
    """201 body. Wraps the row to match CaptureSavedReelResponse's shape."""
    feedback: TripFeedback
```

Verify the imports at the top of `backend/api/schemas.py` already include `Literal`, `BaseModel`, `Field`, and `model_validator`. If `model_validator` is missing, add it to the existing `from pydantic import ...` line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest api/test_schemas.py -q`
Expected: PASS (all new tests green, existing tests unchanged)

- [ ] **Step 5: Add the TypeScript mirror (guardrail #4)**

Append to `frontend/lib/trip/backend-types.ts`. Mirror snake_case 1:1 — this file does **not** camelCase. Use `export type`, not `interface`.

**Write this via a `Bash` heredoc, not the Edit tool** — `.claude/docs/BUILD-LOOP.md:96` records that VS Code's format-on-save applies Prettier defaults (double quotes, semicolons) to frontend files open in the editor, producing large pure-style diffs against this repo's single-quote/no-semicolon style.

```bash
cat >> frontend/lib/trip/backend-types.ts <<'EOF'

// POST /trips/:tripId/feedback — mirrors backend/api/schemas.py TripFeedback*.
// Trip-level only; artifact_type is always 'trip' in v1. The backend does NOT accept
// artifact_type/artifact_id from the client, so they are absent from the request type.
export type TripFeedbackType =
  | 'rating'
  | 'thumbs_up'
  | 'thumbs_down'
  | 'correction'
  | 'free_text'

export type TripFeedbackRequest = {
  feedback_type: TripFeedbackType
  rating?: number | null
  comment?: string | null
}

export type TripFeedback = {
  id: string
  trip_id: string
  artifact_type: 'trip'
  feedback_type: TripFeedbackType
  rating: number | null
  comment: string | null
}

export type TripFeedbackResponse = { feedback: TripFeedback }
EOF
```

- [ ] **Step 6: Verify the frontend still typechecks and the diff is clean**

Run: `git diff --stat frontend/lib/trip/backend-types.ts`
Expected: additions only, roughly +27/-0. **If you see deletions or a much larger diff, format-on-save rewrote the file — `git checkout` it and redo via heredoc.**

Run: `cd frontend && npx tsc --noEmit` (if the repo has a typecheck script, prefer it)
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add backend/api/schemas.py backend/api/test_schemas.py frontend/lib/trip/backend-types.ts
git commit -m "feat(feedback): trip feedback request/response schemas + TS mirror"
```

---

### Task 2: Make the supabase test fake faithful, and fix the stream owner check it was hiding

**Why this task exists (found by the Codex plan review, verified against installed source):**
`_Table.execute()` returns `_Result(matched[0] if matched else None)` for `maybe_single()` — an
object whose `.data` is `None`. The real client returns a **bare `None`**
(`postgrest/_async/request_builder.py:162`: `if len(parsed.data) == 0: return None`). The fake is
*more forgiving than production*, so a route that does `result.data` passes every test and
`AttributeError`s into a 500 in production.

Exactly one production call site has that bug: `backend/main.py:470`, the SSE stream owner check.
Every other site already handles it (`jobs.py:80`, `main.py:301`, `main.py:487`, `organizer.py:76`,
`:184`, `:537`, `:653`, `grounding.py:71`, `preferences.py:25`). No existing test covers the stream
owner check, which is why the bug survived.

**Three fakes share the infidelity; this task fixes ONE, deliberately.** `test_main.py:100`,
`test_jobs.py:127`, and `test_saved_reels_organize.py:221` all return `_Result(None)` where
production returns a bare `None`. Only `test_main.py`'s is fixed here, because only it is needed
for Task 3's tests to be honest.

That is safe, and here is the reasoning rather than an assertion: I audited all 11 production
`maybe_single()` call sites, and every site reached by the other two fakes already guards
correctly. So **no second live bug is hiding behind them.** The residual exposure is narrower and
worth writing down: those correct `is None` guards are *untested* — delete `is None or` from
`jobs.py:80` today and nothing goes red. A future refactor could drop one and ship green.

*Deferred, with a trigger:* fix the other two fakes when someone next touches `jobs.py` or
`organizer.py` error paths. Doing it here would redden an unknown number of the 844 baseline tests
for zero bug-fix value, six days before beta.

This task must land before Task 3: without the honest fake, Task 3's own 404-on-missing-trip test
would pass whether or not its guard exists.

```
BEFORE (fake lies)                      AFTER (fake tells the truth)
  0 rows + maybe_single()                 0 rows + maybe_single()
      -> _Result(data=None)                   -> None
      -> `owner.data` OK  -> 404              -> `owner.data` AttributeError -> 500
      -> test GREEN, prod 500                 -> test RED until the guard is added
```

**Files:**
- Modify: `backend/test_main.py:99` (the `_Table.execute()` single-row branch) and `_Client.__init__`
- Modify: `backend/main.py:470-472` (stream owner check)
- Test: `backend/test_main.py` (new stream owner-check tests — the route currently has none)

**Interfaces:**
- Consumes: nothing.
- Produces, for Task 3:
  - `_Table.execute()` returns `None` (not `_Result(None)`) when `maybe_single()` matches 0 rows.
  - `_Client.empty_result_ops: set[tuple[str, str]]` — `(table, op)` pairs whose `execute()`
    returns `_Result([])`, for testing "the write reported success but returned no row".

- [ ] **Step 1: Write the failing stream owner-check tests**

Append to `backend/test_main.py`:

```python
async def test_stream_on_a_nonexistent_trip_is_404_not_500(ctx, stream_auth):
    # Regression (Codex plan review 2026-08-02): maybe_single() returns a bare None when no
    # row matches, so `owner.data` AttributeErrors into a 500. 500-vs-404 is an existence
    # oracle: it tells an unauthenticated-to-this-trip caller which trip ids are real.
    ac, db, _calls, _client = ctx

    response = await ac.get(f"/generate-trip/stream/{_TRIP_ID}?token=t")

    assert response.status_code == 404


async def test_stream_on_another_users_trip_is_404(ctx, stream_auth):
    ac, db, _calls, _client = ctx
    db.setdefault("trips", []).append({"id": _OTHER_TRIP_ID, "user_id": "user-2"})

    response = await ac.get(f"/generate-trip/stream/{_OTHER_TRIP_ID}?token=t")

    assert response.status_code == 404
```

These reference `_TRIP_ID`/`_OTHER_TRIP_ID`, which Task 3 defines. Define them in **this** task,
directly above these tests, so Task 2 stands alone:

```python
_TRIP_ID = "11111111-1111-4111-8111-111111111111"
_OTHER_TRIP_ID = "22222222-2222-4222-8222-222222222222"
```

**The stream route needs its own auth override — verified, not assumed.** It authenticates via
`get_user_id_from_query_or_header` (`main.py:467`, imported from `auth` at `main.py:42`), NOT
`get_current_user_id_stashed`. The `ctx` fixture overrides only the latter (`test_main.py:180`),
so without this the tests get a real 401 and never reach the owner check they exist to test.

Add this fixture next to `ctx` in `backend/test_main.py`, and take it as a second argument in
both stream tests (`async def test_stream_...(ctx, stream_auth)`). `ctx`'s teardown calls
`dependency_overrides.clear()`, so ordering is safe either way, but the explicit `pop` keeps this
fixture self-contained:

```python
@pytest.fixture
def stream_auth():
    """The stream route uses get_user_id_from_query_or_header (main.py:467), which ctx does
    not override. Same function object as auth's, so keying on main.* resolves correctly."""
    async def _user() -> str:
        return "user-1"

    main.app.dependency_overrides[main.get_user_id_from_query_or_header] = _user
    yield
    main.app.dependency_overrides.pop(main.get_user_id_from_query_or_header, None)
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `cd backend && uv run pytest test_main.py -q -k "stream_on_a"`
Expected: `test_stream_on_a_nonexistent_trip_is_404_not_500` **PASSES** (the fake still lies) and
`test_stream_on_another_users_trip_is_404` PASSES. **This is the point** — both pass against the
dishonest fake. Step 3 makes the fake honest, which turns the first one RED.

- [ ] **Step 3: Make the fake faithful**

In `backend/test_main.py`, change the single-row branch of `_Table.execute()`:

```python
        matched = [r for r in rows if self._matches(r)]
        if self._single:
            # Faithful to postgrest 2.31.0: AsyncMaybeSingleRequestBuilder.execute() returns a
            # bare None when zero rows match (request_builder.py:162), NOT a result whose .data
            # is None. A forgiving fake here hid a real 500 in the stream owner check.
            return _Result(matched[0]) if matched else None
        return _Result(matched)
```

And add the empty-result seam to `_Client.__init__`:

```python
        self.empty_result_ops: set = set()   # {(table, op)} whose execute() returns _Result([])
```

...and honour it in `_Table.execute()`, immediately after the existing `fail_ops` check:

```python
        if (self.name, op) in self._empty_result_ops:
            return _Result([])
```

Thread it through: `_Table.__init__` takes `empty_result_ops=None` and stores
`self._empty_result_ops = empty_result_ops if empty_result_ops is not None else set()`;
`_Client.table()` passes `self.empty_result_ops`.

- [ ] **Step 4: Run the FULL suite — the blast-radius check**

Run: `cd backend && uv run pytest`
Expected: exactly ONE new failure — `test_stream_on_a_nonexistent_trip_is_404_not_500`, with an
`AttributeError: 'NoneType' object has no attribute 'data'`. That failure IS the deployed bug,
now visible.

**If any OTHER test fails, STOP and report it.** It means a second production call site has the
same latent bug, and that is a finding, not something to paper over.

- [ ] **Step 5: Fix the stream owner check**

`backend/main.py:470-472`:

```python
    owner = await client.table("trips").select("user_id").eq("id", trip_id).maybe_single().execute()
    # `owner is None` is load-bearing: maybe_single() returns a bare None on zero rows
    # (postgrest request_builder.py:162). Without it this 500s instead of 404ing, which tells
    # a caller which trip ids exist. Matches jobs.py:80 / main.py:301 / organizer.py:184.
    if owner is None or owner.data is None or owner.data["user_id"] != user_id:  # guardrail #6
        raise HTTPException(status_code=404, detail="Trip not found")
```

- [ ] **Step 6: Fix the same bug in `backend/scripts/live_run.py:44-52`**

Found by Codex round 2 — a second unsafe dereference my audit missed. It matters because this is
the script BUILD-LOOP step 7 uses to live-verify, so it breaks exactly when you point it at a trip
id that does not exist. Note the guard on the next line is currently **unreachable**: the author
wrote `if trip is None:` but `.data` is dereferenced one line above it, so a missing trip
`AttributeError`s before the check runs.

```python
    trip_result = (
        await client.table("trips")
        .select("id,status,destination_hint,start_date,end_date,title,summary,"
                "preference_summary,preference_sources")
        .eq("id", trip_id).maybe_single().execute()
    )
    # maybe_single() returns a bare None on zero rows, so `.data` cannot be read inline --
    # doing so AttributeErrors past the `if trip is None` guard directly below.
    trip = trip_result.data if trip_result is not None else None
    if trip is None:
        print(f"no trip {trip_id}")
        return
```

No test: this is an unimported manual smoke script (nothing in `backend/` imports it), so there is
no seam to test it through and adding one is not worth it. Verify by reading the diff.

- [ ] **Step 7: Run the full suite again**

Run: `cd backend && uv run pytest`
Expected: 844 + the new tests passed, 8 skipped, 0 failed.

- [ ] **Step 8: Prove the fix is load-bearing**

```bash
find . -name __pycache__ -type d -not -path "./.venv/*" -exec rm -rf {} +
```
Remove `owner is None or ` from `main.py:470`, re-run
`cd backend && uv run pytest test_main.py -q -k stream_on_a`, and confirm
`test_stream_on_a_nonexistent_trip_is_404_not_500` goes RED. Restore, clear `__pycache__` again,
confirm green.

- [ ] **Step 9: Commit**

```bash
git add backend/test_main.py backend/main.py backend/scripts/live_run.py
git commit -m "fix(stream): 404 not 500 on a missing trip — maybe_single returns bare None

The in-memory supabase fake returned _Result(data=None) where postgrest 2.31.0
returns a bare None, so main.py:470's owner check passed every test and
AttributeError'd into a 500 in production. That 500-vs-404 split is an
existence oracle. Fake is now faithful; the stream owner check has its first
test. Found by the Codex plan review of the trip-feedback arc."
```

---

### Task 3: The `POST /trips/{trip_id}/feedback` route

**Files:**
- Modify: `backend/main.py` (extend the `from api.schemas import (...)` block at line 30; append the route near the other POST routes)
- Modify: `.claude/docs/ARCHITECTURE.md` (endpoint list)
- Test: `backend/test_main.py` (append at end of file)

**Interfaces:**
- Consumes from Task 1: `TripFeedbackRequest`, `TripFeedback`, `TripFeedbackResponse`.
- Consumes from Task 2: the faithful `_Table.execute()` (bare `None` on a zero-row
  `maybe_single()`), `_Client.empty_result_ops`, and the module-level `_TRIP_ID` /
  `_OTHER_TRIP_ID` constants. **Do not redefine those constants** — Task 2 already added them.
- Produces: the HTTP contract `POST /trips/{trip_id}/feedback` → `201 {"feedback": {...}}`.

**Route-shape requirements (all load-bearing, all easy to get wrong):**
1. The first parameter must be **literally named `request`** — slowapi's `key_func` resolves it by name.
2. A `response: Response` parameter is **required** because the limiter is built with `headers_enabled=True` (`rate_limit.py:47`); slowapi writes `X-RateLimit-*`/`Retry-After` into it.
3. Use `get_current_user_id_stashed` (not `get_current_user_id`) — it sets `request.state.user_id`, which is what `rate_limit_key` reads to key the bucket on the user instead of the shared client IP.
4. `trip_id` is typed `UUID` so a malformed path segment is a clean **422** instead of reaching Postgres as `invalid input syntax for type uuid` and surfacing as a 500. Convert with `str(trip_id)` before handing it to supabase-py — a raw `UUID` object is not JSON-serialisable.

- [ ] **Step 1: Write the failing route tests**

Append to `backend/test_main.py`. These reuse the existing `ctx` fixture, which authenticates as `"user-1"` and swaps in the `_Client` in-memory fake.

```python
# --- POST /trips/{trip_id}/feedback ------------------------------------------------
# _TRIP_ID and _OTHER_TRIP_ID were added in Task 2 — do not redefine them here.


def _seed_trip(db, trip_id=_TRIP_ID, user_id="user-1", status="completed"):
    db.setdefault("trips", []).append({"id": trip_id, "user_id": user_id, "status": status})


async def test_feedback_rating_is_stored_for_the_owner(ctx):
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback",
        json={"feedback_type": "rating", "rating": 4, "comment": "loved day 2"},
    )

    assert response.status_code == 201
    body = response.json()["feedback"]
    assert body["trip_id"] == _TRIP_ID
    assert body["artifact_type"] == "trip"
    assert body["rating"] == 4
    assert body["comment"] == "loved day 2"

    rows = db["feedback"]
    assert len(rows) == 1
    assert rows[0]["trip_id"] == _TRIP_ID          # STORED trip_id, from the path (gap found in review)
    assert rows[0]["user_id"] == "user-1"          # from the token, never the body
    assert rows[0]["artifact_type"] == "trip"
    assert rows[0]["artifact_id"] is None
    # PRD:1035 columns are deliberately deferred for trip-level feedback.
    assert rows[0]["source_type"] is None
    assert rows[0]["generation_stage"] is None
    assert rows[0]["preference_source"] is None


@pytest.mark.parametrize(
    "payload",
    [
        {"feedback_type": "thumbs_up"},
        {"feedback_type": "thumbs_down", "comment": "too much walking"},
        {"feedback_type": "free_text", "comment": "great but rushed"},
        {"feedback_type": "correction", "comment": "the museum is closed Mondays"},
    ],
)
async def test_feedback_accepts_every_non_rating_type(ctx, payload):
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    response = await ac.post(f"/trips/{_TRIP_ID}/feedback", json=payload)

    assert response.status_code == 201
    assert db["feedback"][0]["feedback_type"] == payload["feedback_type"]


async def test_feedback_on_another_users_trip_is_404_and_writes_nothing(ctx):
    # THE owner-check test (guardrail #6). service_role bypasses RLS, so this app-code
    # check is the ONLY thing standing between a caller and someone else's trip.
    ac, db, _calls, _client = ctx
    _seed_trip(db, trip_id=_OTHER_TRIP_ID, user_id="user-2")

    response = await ac.post(
        f"/trips/{_OTHER_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"}
    )

    assert response.status_code == 404          # 404 not 403 — do not confirm the trip exists
    assert db.get("feedback", []) == []         # the write must not have happened


async def test_feedback_on_a_nonexistent_trip_is_404(ctx):
    ac, db, _calls, _client = ctx

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"}
    )

    assert response.status_code == 404
    assert db.get("feedback", []) == []


async def test_feedback_is_accepted_on_a_failed_trip(ctx):
    # Deliberate: "this didn't work" is the most valuable beta signal we can collect.
    ac, db, _calls, _client = ctx
    _seed_trip(db, status="failed")

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_down", "comment": "failed"}
    )

    assert response.status_code == 201


async def test_feedback_is_append_only(ctx):
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    first = await ac.post(f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "rating", "rating": 2})
    second = await ac.post(f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "rating", "rating": 5})

    assert first.status_code == 201
    assert second.status_code == 201
    assert [r["rating"] for r in db["feedback"]] == [2, 5]
    assert first.json()["feedback"]["id"] != second.json()["feedback"]["id"]


async def test_feedback_rejects_a_client_supplied_user_id(ctx):
    # user_id must come from the token. extra="forbid" makes smuggling it a 422.
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback",
        json={"feedback_type": "thumbs_up", "user_id": "user-2"},
    )

    assert response.status_code == 422
    assert db.get("feedback", []) == []


async def test_feedback_rejects_a_client_supplied_artifact_target(ctx):
    # Aiming feedback at an arbitrary artifact must not be possible on this endpoint.
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback",
        json={"feedback_type": "thumbs_up", "artifact_type": "place", "artifact_id": _OTHER_TRIP_ID},
    )

    assert response.status_code == 422
    assert db.get("feedback", []) == []


async def test_feedback_rejects_a_malformed_trip_id_before_touching_the_db(ctx):
    ac, db, _calls, client = ctx

    response = await ac.post("/trips/not-a-uuid/feedback", json={"feedback_type": "thumbs_up"})

    assert response.status_code == 422
    assert db.get("feedback", []) == []


async def test_feedback_requires_authentication():
    # No ctx fixture: the real auth dependency runs, so no Authorization header -> 401.
    async with _async_client() as ac:
        response = await ac.post(
            f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"}
        )
    assert response.status_code == 401


async def test_feedback_burst_limit_returns_429(ctx):
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    codes = []
    for _ in range(4):
        r = await ac.post(f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"})
        codes.append(r.status_code)

    assert codes[:3] == [201, 201, 201]   # BURST_LIMIT default is 3/minute
    assert codes[3] == 429


async def test_feedback_insert_raising_surfaces_as_500_not_a_silent_success(ctx):
    # A LOCAL transport with raise_app_exceptions=False. The shared `ac` from ctx defaults to
    # True, so Starlette's error middleware sends the 500 AND re-raises -- httpx then re-raises
    # into the test, which crashes before the assert instead of failing it. Same reason and
    # same pattern as test_main.py:405.
    _ac, db, _calls, client = ctx
    _seed_trip(db)
    client.fail_ops.add(("feedback", "insert"))

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        response = await ac.post(f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"})

    assert response.status_code == 500
    assert db.get("feedback", []) == []


async def test_feedback_insert_returning_no_rows_is_a_500(ctx):
    # Distinct from the raising case: this is the ONLY test that makes the explicit
    # `if not inserted.data` guard load-bearing.
    #
    # THE STATUS CODE CANNOT TELL THE TWO PATHS APART (Codex round 2, demonstrated by
    # execution). Delete the guard and `inserted.data[0]` raises IndexError, which the global
    # unhandled_exception_handler ALSO renders as a 500 with an empty db -- so asserting
    # `status_code == 500` and `db == []` stays green either way. Only the MESSAGE differs:
    #   guard present -> {"code": "internal_error", "message": "Failed to store feedback"}
    #   guard deleted -> {"code": "internal_error", "message": "Internal server error"}
    # The message assertion below is therefore the whole test. Do not drop it.
    _ac, db, _calls, client = ctx
    _seed_trip(db)
    client.empty_result_ops.add(("feedback", "insert"))

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        response = await ac.post(f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"})

    assert response.status_code == 500
    assert response.json()["error"]["message"] == "Failed to store feedback"
    assert db.get("feedback", []) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest test_main.py -q -k feedback`
Expected: **every** feedback test fails, all for the same reason — no route matches
`POST /trips/{trip_id}/feedback`, so Starlette returns a framework 404 before any dependency,
path coercion, or body validation runs. In particular the 401-auth and 422-malformed-UUID tests
fail here too (they get 404, not their expected status); they do NOT coincidentally pass. Any
feedback test that PASSES at this step is asserting nothing — investigate it before continuing.

- [ ] **Step 3: Implement the route**

First extend the schema import block at `backend/main.py:30`:

```python
from api.schemas import (
    # ... existing names, unchanged ...
    TripFeedback,
    TripFeedbackRequest,
    TripFeedbackResponse,
)
```

Add `from uuid import UUID` to the stdlib imports at the top of `backend/main.py`.

Add the `extra="forbid"` subclass next to `_CaptureSavedReelRequest` (`main.py:207-208`):

```python
class _TripFeedbackRequest(TripFeedbackRequest):
    model_config = ConfigDict(extra="forbid")
```

Append the route after `create_saved_reel` (`main.py:265-278`):

```python
@app.post("/trips/{trip_id}/feedback", response_model=TripFeedbackResponse, status_code=201)
@limiter.limit(BURST_LIMIT)
async def submit_trip_feedback(
    request: Request,          # must be named `request` — slowapi's key_func resolves it by name
    response: Response,        # required: the limiter is headers_enabled=True
    trip_id: UUID,             # UUID (not str) so a malformed id is a 422, never a Postgres 500
    req: _TripFeedbackRequest,
    user_id: str = Depends(get_current_user_id_stashed),
) -> TripFeedbackResponse:
    """Trip-level feedback (PRD §18, PRD:86 beta adoption metric).

    Append-only: a resubmission inserts another row rather than replacing. The table has
    no unique constraint, and a user who rates 2 then 5 after re-reading the itinerary is
    signal worth keeping; analytics take latest-per-user via feedback_user_id_created_at_idx.

    Owner check is app-code, NOT RLS: this backend connects with service_role, which is
    exempt from every RLS policy (persist.py:515). feedback_insert_own_trip is a backstop
    for a future direct-from-frontend path only.
    """
    trip_key = str(trip_id)
    client = await get_supabase_client()

    owner = await client.table("trips").select("user_id").eq("id", trip_key).maybe_single().execute()
    # `owner is None` is load-bearing, NOT defensive noise. postgrest 2.31.0's
    # AsyncMaybeSingleRequestBuilder.execute() returns a bare None when zero rows match
    # (request_builder.py:162: `if len(parsed.data) == 0: return None`) -- NOT an object whose
    # .data is None. Dereferencing owner.data would AttributeError into a 500, which leaks an
    # existence oracle: 500 = no such trip, 404 = exists but not yours. This matches the repo's
    # majority convention (jobs.py:80, main.py:301, organizer.py:184) -- main.py:470 was the
    # one outlier, and Task 3 fixes it.
    if owner is None or owner.data is None or owner.data["user_id"] != user_id:  # guardrail #6
        raise HTTPException(status_code=404, detail="Trip not found")  # 404 not 403: do not confirm existence

    inserted = await client.table("feedback").insert({
        "trip_id": trip_key,
        "user_id": user_id,               # from the token, never the body
        "artifact_type": "trip",          # trip-level scope; artifact-level is a later, additive arc
        "artifact_id": None,
        "feedback_type": req.feedback_type,
        "rating": req.rating,
        "comment": req.comment,
        # PRD:1035's source_type / generation_stage / preference_source stay NULL for
        # trip-level feedback -- they describe how an ARTIFACT was generated.
        "source_type": None,
        "generation_stage": None,
        "preference_source": None,
    }).execute()

    if not inserted.data:
        raise HTTPException(status_code=500, detail="Failed to store feedback")

    # Build the response from the PERSISTED row, not from the request (plan-eng-review A2).
    # Echoing req.* would make the 201 body incapable of ever reporting a persistence bug:
    # it would look correct even if the row were wrong. Every field read here is part of the
    # insert payload above, so it is present in BOTH the real client and the _Table test fake
    # (only created_at would diverge, which is why the response omits it).
    row = inserted.data[0]
    return TripFeedbackResponse(
        feedback=TripFeedback(
            id=str(row["id"]),
            trip_id=str(row["trip_id"]),
            artifact_type=row["artifact_type"],
            feedback_type=row["feedback_type"],
            rating=row["rating"],
            comment=row["comment"],
        )
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest test_main.py -q -k feedback`
Expected: PASS, all of them.

- [ ] **Step 5: Prove the owner check is load-bearing (fault injection — REQUIRED)**

`.claude/docs/BUILD-LOOP.md:187-214` requires proving a guard is real, not assumed. Do this exactly:

```bash
find . -name __pycache__ -type d -not -path "./.venv/*" -exec rm -rf {} +
cp backend/main.py /tmp/main.py.bak
```

Run **three** separate injections; each must redden a specific test:

| Injection | Must turn RED | Proves |
|---|---|---|
| Comment out the whole `if owner is None or ... raise` block | `test_feedback_on_another_users_trip_is_404_and_writes_nothing` **and** `test_feedback_on_a_nonexistent_trip_is_404` | the owner check exists |
| Delete only `owner is None or ` from the condition | `test_feedback_on_a_nonexistent_trip_is_404` (AttributeError → 500) | the bare-`None` branch is load-bearing, not defensive noise |
| Delete the `if not inserted.data: raise` guard | `test_feedback_insert_returning_no_rows_is_a_500`, **on its message assertion, not its status assertion** | the empty-write guard is real. The *raising* test still passes here, and so would this one on status alone — `inserted.data[0]` IndexErrors into an identical 500. Only `"Failed to store feedback"` vs `"Internal server error"` separates them. |

```bash
cd backend && uv run pytest test_main.py -q -k "another_users_trip or nonexistent_trip or insert_returning"
```

If any listed test still passes under its injection, the test is not testing the guard — fix the test, not the code.

Restore and clear stale bytecode (restoring a file can leave a `.pyc` that looks current, so the interpreter keeps running faulted code while `git status` reads clean):

```bash
cp /tmp/main.py.bak backend/main.py && rm /tmp/main.py.bak
find . -name __pycache__ -type d -not -path "./.venv/*" -exec rm -rf {} +
cd backend && uv run pytest test_main.py -q -k feedback   # green again
```

Repeat the same delete-and-watch-it-redden check for the `extra="forbid"` subclass: swap `_TripFeedbackRequest` for `TripFeedbackRequest` in the signature and confirm `test_feedback_rejects_a_client_supplied_user_id` and `test_feedback_rejects_a_client_supplied_artifact_target` both go red. Restore afterwards.

- [ ] **Step 6: Run the full backend suite + the eval gate**

Run: `cd backend && uv run pytest`
Expected: 844 passed + the new tests, 8 skipped, **0 failed**. The 844/8 baseline is from `dev` @ `e0f5bcb`; any pre-existing failure is a signal you changed something unrelated.

Run: `cd backend && uv run pytest evals/ -q`
Expected: PASS with the frozen `#16` anchor `6229.0` unmoved. (Do not chase the `run_eval` CLI's `8163.7` headline — different subject, per BUILD-LOOP.md:108.)

- [ ] **Step 7: Update the endpoint list in ARCHITECTURE.md**

Add `POST /trips/:tripId/feedback` to the endpoints section of `.claude/docs/ARCHITECTURE.md`, matching the surrounding format, with a one-line note: *trip-level only (`artifact_type='trip'`); append-only; owner-checked in app code because service_role bypasses RLS.*

- [ ] **Step 8: Commit**

```bash
git add backend/main.py backend/test_main.py .claude/docs/ARCHITECTURE.md
git commit -m "feat(feedback): POST /trips/:tripId/feedback — trip-level, append-only, owner-checked"
```

---

## Verification (whole arc)

| Check | Command | Expected |
|---|---|---|
| Backend suite | `cd backend && uv run pytest` | 844 + new passed, 8 skipped, 0 failed |
| Eval anchor | `cd backend && uv run pytest evals/ -q` | green, `6229.0` unmoved |
| Frontend types | `cd frontend && npx tsc --noEmit` | no new errors |
| Frontend diff hygiene | `git diff --stat frontend/` | additions only, no style churn |
| No stray files | `git status --short` | only the files this plan names; **nothing under `backend/telegram_ingest/`** |

## Live-verify (BUILD-LOOP step 7 — needs the user's go before running)

Against the deployed stack with a real Supabase JWT:
1. `POST /trips/{own_trip_id}/feedback` with `{"feedback_type":"rating","rating":4}` → **201**, row visible in the Supabase `feedback` table with `artifact_type='trip'`, `artifact_id` NULL, and `user_id` matching the token's `sub`.
2. `POST /trips/{another_users_trip_id}/feedback` → **404**, and **no row written** (this is the guardrail #6 proof; the repo has 25 live trips to pick a non-owned one from).
3. `POST` with no `Authorization` header → **401**.
4. `POST /trips/{a-well-formed-uuid-that-does-not-exist}/feedback` → **404**, NOT 500. This is the
   Codex-found case; `/health` cannot catch it, so it must be checked by hand.
5. `GET /generate-trip/stream/{nonexistent-uuid}` → **404**, NOT 500 (the Task 2 stream fix).

## Rollback risk

**Low, with one caveat that did not exist before Task 2 was added.**

Task 1 and Task 3 are purely additive: one new route, three new Pydantic models, three new TS
types, no migration, no change to any existing code path. Nothing reads the `feedback` table yet,
so a bad row is inert.

Task 2 is the only task that touches existing behaviour. Its production change is one condition on
`backend/main.py:470`, strictly widening a guard that already returned 404 — a caller who used to
get a 500 now gets a 404, and no other status changes. Its test change makes the shared `_Table`
fake stricter, which affects test code only, never production.

Rollback is `git revert` of the three commits: no schema to unwind, no data to migrate. Reverting
Task 2 alone restores the 500 behaviour but breaks nothing else.

**Deployment note (unchanged and important):** Render deploys from `dev` with `autoDeploy: false`.
**Merging is not deploying.** Both the feedback endpoint and the stream fix stay dormant in
production until someone triggers a Render deploy. Tell Zhi Hao explicitly — otherwise he builds
the UI against a route that merged but is not live.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | outside voice (`codex exec -m gpt-5.6-sol`) | Independent 2nd opinion | 2 | CLEAR | R1 **FAIL 6.8** (2 MAJOR, 2 MINOR) → R2 **PASS 7.9** (1 MAJOR, 2 MINOR, all folded) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 issues, 2 test gaps, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | backend-only, not applicable |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**Completion summary**
- Step 0 Scope Challenge — scope accepted as-is (6 files, 0 new classes/services, 0 deps, 0 migrations), then **deliberately widened once** by user decision S1 to fix a deployed bug the review exposed.
- Architecture Review: 2 issues (A1 `ON DELETE CASCADE` erases feedback once `DELETE /trips` ships → documented TODO; A2 response echoed the request instead of the persisted row → fixed).
- Code Quality Review: 0 issues.
- Test Review: coverage diagram produced, 2 gaps (stored `trip_id` never asserted; no `comment == 2000` boundary) → both folded in.
- Performance Review: 0 issues. One indexed SELECT + one INSERT per call.
- NOT in scope: written (5 deferrals, each with a concrete trigger).
- What already exists: written — the `feedback` table + RLS, `get_current_user_id_stashed`, `limiter`, `get_supabase_client`, the `_Client` fake and the global error handlers are all reused, none rebuilt.
- Failure modes: 0 critical gaps.
- Outside voice: ran (Codex `gpt-5.6-sol`, 2 rounds).
- Parallelization: Task 1 and Task 2 are independent (different concerns, no shared symbols); Task 3 depends on both. `Lane A: Task 1` / `Lane B: Task 2` → `Task 3`. Both lanes touch `backend/`, so a worktree split is not worth the coordination for a 3-task arc — **run sequentially**.

**CODEX:** Round 1 FAIL 6.8 caught that `postgrest 2.31.0`'s `maybe_single()` returns a bare `None`, so the planned `owner.data` check would 500 instead of 404 — an existence oracle. Tracing it exposed the same bug in *deployed* code at `main.py:470` plus a third instance at `scripts/live_run.py:44`. Round 2 PASS 7.9 caught that the empty-insert guard was still not load-bearing because `IndexError` and the explicit guard produce an identical 500; only the error *message* separates them.

**CROSS-MODEL:** No tension. The two reviews found disjoint classes of defect — the Claude pass found contract and data-lifecycle issues (response fidelity, cascade), Codex found runtime-library behaviour verified by execution against locked versions. Neither found anything the other did; both agreed the no-migration call and all five accepted scope limits are sound.

**Accepted, not fixed (1):** no test distinguishes reading the response from the persisted row versus echoing the request, because the fake returns the insert payload unchanged, so both produce identical output. Codex classes this as a test-coverage gap, not a production defect. Building a fake that mutates on write to close it is not worth the complexity here.

**VERDICT:** ENG + CODEX CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
