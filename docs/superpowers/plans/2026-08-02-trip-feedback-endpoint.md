# Trip Feedback Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `POST /trips/{trip_id}/feedback` so the 2026-08-08 beta has an instrument for its primary success metric (PRD:86 — "real users … provide feedback").

**Architecture:** One new route in `backend/main.py` following the established bare-`@app.post` convention (there is no routers package). Auth → rate limit → app-code owner check on `trips` → single append-only INSERT into the already-deployed `feedback` table. Scope is trip-level only (`artifact_type='trip'`, `artifact_id=NULL`); the table and its RLS already accept the other five artifact types, so artifact-level feedback is purely additive later with no migration.

**Tech Stack:** FastAPI · Pydantic v2 · supabase-py v2 `AsyncClient` (service_role) · slowapi · pytest + httpx `ASGITransport`.

## Global Constraints

- **No migration.** The `feedback` table already exists (`supabase/migrations/20260702012806_generated_trip_outputs.sql:85`) and was verified live in deployed Supabase on 2026-08-02 (read-only probe: `HTTP 200`, 0 rows). Do not write a migration file.
- **Guardrail #5 — auth on every endpoint.** Use `get_current_user_id_stashed`; never accept `user_id` from the body or query.
- **Guardrail #6 — owner check in APP CODE.** `service_role` bypasses RLS (`backend/pipeline/persist.py:515`), so the `feedback_insert_own_trip` policy is **not** the enforcement path here. The route must itself verify the trip belongs to the caller.
- **404, never 403.** Every existing owner check in this repo (`main.py:470-472`, `organizer.py:181-185`) makes "trip absent" and "trip not yours" indistinguishable. Match it exactly.
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

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `backend/api/schemas.py` | `TripFeedbackRequest`, `TripFeedback`, `TripFeedbackResponse` + cross-field validator | Modify (append) |
| `backend/main.py` | The route: auth, limit, owner check, insert | Modify (append route + import) |
| `frontend/lib/trip/backend-types.ts` | snake_case 1:1 TS mirror (guardrail #4) | Modify (append) |
| `backend/test_main.py` | Route tests reusing the `_Client` in-memory-DB fake + `ctx` fixture | Modify (append) |
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
- Produces, for Task 2:
  - `TripFeedbackRequest(feedback_type: Literal["rating","thumbs_up","thumbs_down","correction","free_text"], rating: int | None, comment: str | None)`
  - `TripFeedback(id: str, trip_id: str, artifact_type: Literal["trip"], feedback_type: str, rating: int | None, comment: str | None)`
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
    rating: int | None = Field(default=None, ge=1, le=5)
    comment: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def check_rating_matches_feedback_type(self):
        if self.feedback_type == "rating" and self.rating is None:
            raise ValueError("rating is required when feedback_type is 'rating'")
        if self.feedback_type != "rating" and self.rating is not None:
            raise ValueError("rating is only valid when feedback_type is 'rating'")
        if self.feedback_type in ("free_text", "correction") and not self.comment:
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

### Task 2: The `POST /trips/{trip_id}/feedback` route

**Files:**
- Modify: `backend/main.py` (extend the `from api.schemas import (...)` block at line 30; append the route near the other POST routes)
- Modify: `.claude/docs/ARCHITECTURE.md` (endpoint list)
- Test: `backend/test_main.py` (append at end of file)

**Interfaces:**
- Consumes from Task 1: `TripFeedbackRequest`, `TripFeedback`, `TripFeedbackResponse`.
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

_TRIP_ID = "11111111-1111-4111-8111-111111111111"
_OTHER_TRIP_ID = "22222222-2222-4222-8222-222222222222"


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


async def test_feedback_insert_failure_surfaces_as_500_not_a_silent_success(ctx):
    ac, db, _calls, client = ctx
    _seed_trip(db)
    client.fail_ops.add(("feedback", "insert"))

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"}
    )

    assert response.status_code == 500
    assert db.get("feedback", []) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest test_main.py -q -k feedback`
Expected: FAIL — all with 404 (route not registered) except the 401 and 422-malformed cases, which may coincidentally pass. **Do not treat those coincidental passes as coverage**; they must be re-verified in Step 4.

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
    if owner.data is None or owner.data["user_id"] != user_id:  # guardrail #6 owner check
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

    row = inserted.data[0]
    return TripFeedbackResponse(
        feedback=TripFeedback(
            id=str(row["id"]),
            trip_id=trip_key,
            feedback_type=req.feedback_type,
            rating=req.rating,
            comment=req.comment,
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

Comment out the two owner-check lines (`if owner.data is None or ...` and the `raise`), then:

```bash
cd backend && uv run pytest test_main.py -q -k "another_users_trip or nonexistent_trip"
```

Expected: **both tests FAIL.** If either still passes, the test is not testing the guard — fix the test, not the code.

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

## Rollback risk

**Very low.** Additive only: one new route, three new Pydantic models, three new TS types, no migration, no change to any existing code path. Nothing reads the `feedback` table yet, so a bad row is inert. Rollback is `git revert` of the two commits — no schema to unwind, no data to migrate, and the `feedback` table simply returns to receiving zero writes.

**The one real deployment note:** Render deploys from `dev` with `autoDeploy: false`, so **merging is not deploying**. The endpoint returns 404 in production until someone triggers a Render deploy. Tell Zhi Hao explicitly — otherwise he builds the UI against a route that merged but is not live.
