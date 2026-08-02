# PLAN A — Telegram reel-ingestion bot

> Status: **PLAN, revision 9 — PASSED REVIEW.**
> **Round 8: 8.5/10, READY TO IMPLEMENT** (Correctness 8.8, Deployment safety 8.6, Completeness 8.4,
> Risk 8.8, Clarity 7.8). **No blockers, no majors.** Eight rounds:
> 4.6 → 5.2 → 5.5 → 6.4 → 6.8 → 6.0 → 6.5 → **8.5**. Rev 9 folds the three documentation-hygiene
> minors round 8 listed as explicitly NOT blocking; the passing verdict was rendered on rev 8, and
> nothing in rev 9 touches design, sequencing, or scope.
>
> **Correctness rose every round after the rev-4 simplification: 6.5 → 7.8 → 8.2 → 8.8.** The
> architecture settled at rev 4 (round 4 verified F1/F2/F3 TRUE — *"the deleted coordination
> machinery should stay deleted"*) and rounds 5–8 confirmed no structural rewrite was needed.
> **Deployment safety was the last dimension to clear, and every defect in it was a
> RUNBOOK-SEQUENCING error of mine, not a design flaw** — rev 5 suspended the API without resuming
> it, rev 6 resumed it after a deploy that cannot run while suspended, rev 6 also left a Blueprint
> path that Render structurally cannot make safe. Rev 8 rewrote both sequences end to end rather
> than patching them again, which moved the dimension 2.5 → 8.6 in one round.
> **0 new tables · 0 new RPCs · 1 migration · 1 pinning line in the live `render.yaml` block.**
> Bar was ≥7.0 with no dimension ≤3; every dimension cleared at ≥7.8.
> Companion: `2026-08-01-extractor-place-cache.md` (PLAN B, scope-cut to T1–T3).
> Author: Shaun · Date: 2026-08-01

## 1. Context

People share Instagram Reel URLs into one Telegram group. Each URL gets scraped and extracted once,
warming three **global** caches that every website user already reads — `reel_cache`,
`geocode_country_cache`, `places`. Ceiling ~100 reels/day. Nothing here is user-facing.

**The engine already exists.** `organizer._process_item` (`backend/organizer.py:518-642`) is the
complete per-reel pipeline, inside a durable lease-fenced job with a reaper. This is a **new front
door onto an existing engine**.

**What it buys:** `reel_cache` is keyed on `normalized_url` alone, service-role only
(`backend/pipeline/cache.py:16`), so a hit skips Apify **and** OpenAI **and** the quota charge
(`organizer.py:549,567-573`). **What it does not buy:** `reel_place_mentions` is per-user and gates
the `place_ids` fast path, so a website user still runs their own organize — just warm and free.

## 2. What three review rounds actually taught us

Verified in the deployed SQL. Each fact deletes a chunk of rev 3:

**F1 — `create_saved_reels_organize_job` checks the idempotency key BEFORE the AS409 overlap check**
(`20260720130000_organize_job_error_codes.sql:69-77` then `:79-91`). `_request_key` is
`sha256([user_id, sorted(set(ids))])` (`organizer.py:66-68`), so for a **single-item** job it is a
pure function of `(user_id, saved_reel_id)`. A retry therefore hits the idempotency branch and
returns the existing job id — **AS409 is structurally unreachable for single-item ingest jobs.**
That deletes: batching, the linger timer, the in-process dedupe set, split-and-retry,
`blocking_job_id`, the `waiting` state, and round-2's blocker B2 entirely.

**F2 — `reserve_organize_item_analysis` is already exactly-once**, short-circuiting on
`v_state in ('reserved','consumed')` (`20260719101000_saved_reels_exactly_once_quota.sql:62-64`),
with a composite CHECK, a tested refund, and a dangling-reservation sweeper (`organizer.py:304-341`).
A second quota ledger was duplicating shipped, tested machinery — and *that duplication* was what
made round-2's B1 double-charge possible. **Deleting `telegram_ingest_usage` deletes B1**, both new
RPCs, the marker's charge-state machine, and the marker's only real justification.

**F3 — `recover_organize_jobs` already lists every pending job with no user filter**
(`organizer.py:374`), redispatched every 120 s under `_RECOVERY_SEM(3)` (`main.py:66,102-129`), with
a CAS claim that returns a clean `{"skipped": "job already claimed"}` on a race
(`organizer.py:667`). **The durable queue and its reaper already cover ingest jobs, with zero code
changes.** Rev 3's recovery split *removed* ingest jobs from that net — creating the stranding it
then needed a clock RPC and a live-path refactor to repair.

> Codex round 3, unprompted, on rev 3: *"Plan A's added coordination machinery is now its largest
> deployment risk … Delete this machinery rather than adding watchdogs and more states."*

## 3. Design

```
getUpdates ──► filter ──► capture ──► create job ──► enqueue ──► react ──► advance offset
                (pure)    (idempotent  (idempotent    (in-proc,   (best-    (only after ALL
                           upsert)      single-item)   lossy OK)   effort)   urls handled)

durable queue = organize_jobs  (shipped, leased, CAS-claimed, reaped)
recovery      = main._reap_loop (shipped, 120s, global, UNCHANGED)
spend bound   = users.daily_reel_analysis_limit on the ingest account
```

**The in-process queue is a latency optimization, not a durability mechanism.** The job row exists
before anything is enqueued, so `QueueFull` or a worker crash simply means the **existing web
reaper** runs that job within 120 s. Nothing to reconcile, nothing to mark.

### 3.1 A decision stated out loud, not an oversight

**For this bot, "not silent" is the bar — not "never lost".** If an update fails in a way that
cannot be retried, the poller logs at **ERROR** and advances the offset. The reel is dropped
*loudly*, and a human re-shares the URL. Justification: ~100 reels/day, no user-facing surface, and
the alternative (never advancing the offset) is an infinite redelivery loop on a poison update.
Guardrail #12 forbids *silent* drops; this is the opposite of silent.

**[R4/M1] "Loud" has to be true end-to-end, or this is a cop-out.** Round 4 found rev 4 still had
silent paths *before* job creation, and judged the decision itself defensible but the implementation
overstated. Three things make it real, all specified in T4: every caught per-URL failure logs at
ERROR; an Instagram-looking URL that `normalize_reel_url` rejects logs at ERROR instead of vanishing
into the filter's `ValueError` swallow; and the ✅ reaction is emitted **once per message, only when
the message is wholly clean** — no rejected shapes, no truncation, and every URL durable — so its
absence is the human-visible signal. Paired with the pinned-message contract in T4, "the human
re-shares" becomes a real recovery path rather than a hope.

Everything *upstream* of that is still durable: once `create_organize_job` returns, the job is in a
leased, reaped queue and will run.

## 4. Modules — `backend/telegram_ingest/`

Six files. **`telegram_ingest/`, never `telegram/`** — `python-telegram-bot` installs as a top-level
`telegram` module and would be shadowed with `backend/` as cwd (the repo already has this scar:
`genagents/` exists because the OpenAI SDK shadowed `agents/`).

| File | Contents |
|---|---|
| `api.py` | `get_updates`, `set_message_reaction`, `get_me`, `get_chat_member`. **No `send_message`** |
| `reel_filter.py` | The only function that reads message text. Pure |
| `config.py` | Frozen dataclass + allowlist (absorbs `authz`) |
| `ingest.py` | `handle_update` — four statements per URL |
| `poller.py` | Long poll, offset-as-ack, backoff, heartbeat |
| `worker.py` | Boot, consumer task, SIGTERM drain |

No new dependency: `httpx>=0.27.0` is already at `backend/pyproject.toml:11`, and
`backend/scrape/apify_direct.py` is the precedent (direct HTTP, injectable client,
`httpx.MockTransport` in tests). A framework for four endpoints would land in the **shared**
`pyproject.toml` the web service also builds from.

## 4.1 [IMPL 2026-08-02] Two cross-cutting defect classes found during implementation

Both were hit **independently in three separate modules** by three implementers. Neither appears in
the plan's original text, and eight review rounds did not surface either — you cannot fault-inject a
document, and both are properties of Python rather than of this design.

**CLASS 1 — an implicitly chained exception leaks whatever the swallowed one carried.** Python sets
`__context__` on any exception raised inside an `except` block, and `traceback.format_exception` (so
also `logger.exception(...)` and `exc_info=True`) prints it exactly as it prints an explicit
`__cause__`. **Swallowing an exception does not erase it.** Three instances, three asset classes:

| Module | The swallowed exception carries | Fix |
|---|---|---|
| `api.py` (T1) | `httpx.HTTPStatusError`'s `str()` **is** the URL, and the bot token is in the URL path | `raise … from None` |
| `reel_filter.py` (T2) | `normalize_reel_url`'s `ValueError` message **is** the candidate URL — untrusted group content. `urlparse("https://[::1/reel/A")` raises *from inside that very handler* | narrow `except ValueError` at each risky stdlib call |
| `config.py` (T3) | `int()` and `uuid.UUID()` both put the string they rejected into their **own** `ValueError`, so a pasted token in `TELEGRAM_ALLOWED_CHAT_IDS` reaches the boot log through a spotless message | parsers return a value-free reason and never raise; the single `raise` sits **outside** every `except` |

**The testing consequence:** a leak assertion on `str(exc)` is insufficient. Assert on
`traceback.format_exception(...)`. Every one of these passed a `str(exc)` check.

**CLASS 2 — `int()` does not mean "an integer".** It accepts every Unicode decimal script and PEP 515
underscores: `int("٤٢") == 42`, `int("４２") == 42`, `int("4_2") == 42`, `int("+100123") == 100123`.
On an **allowlist** that is an authorization bypass — the string authorizes a chat other than the one
a human reading the Render dashboard sees. `TELEGRAM_ALLOWED_CHAT_IDS` is parsed with a strict
`-?[0-9]+` fullmatch, with `int()` behind it only for CPython's 4300-digit limit. Anywhere else in
the codebase that parses an identifier from config or untrusted input has the same exposure.

**A method note, because it produced two of the three:** fault injection proves the guards you *have*
are load-bearing; it is structurally blind to a guard that was never written. T2 shipped 21 passing
faults and still had a Critical. Run a **separate absence pass** — *which described behaviour has no
code and no test at all?* — as its own sweep. In T3 that pass found an allow-all mutation of
`is_allowed_chat` that **no behavioural test could ever have caught**, because the only object
exposing it was one the loader never builds; the fix was to make the empty allowlist unconstructable
in `__post_init__`, turning fail-closed into a property of the type.

## 5. Tasks

### T0 — SPIKE: what URL forms does the Instagram share sheet produce? ✅ DONE 2026-08-02

**RESULT: PASS, 3/3. No redirect resolver. T2 stays pure — no network, no SSRF surface.**

Shaun shared three reels from the iOS Instagram share sheet into Telegram Saved Messages and
recorded the raw strings. Run through `normalize_reel_url` (`backend/scrape/reel_url.py:32`):

| Raw string from the share sheet | Result |
|---|---|
| `https://www.instagram.com/reel/Da2Qec8x6nx/?igsh=aWtwdnkxYzB2YTJu` | ✅ → `…/reel/Da2Qec8x6nx` |
| `https://www.instagram.com/reel/DaxnJsIyAW3/` | ✅ → `…/reel/DaxnJsIyAW3` |
| `https://www.instagram.com/reel/DaZ8wwLyWMM/` | ✅ → `…/reel/DaZ8wwLyWMM` |

The share sheet emits the **canonical** `https://www.instagram.com/reel/<code>/` form, sometimes with
an `?igsh=` tracking parameter. That parameter is harmless: `_reel_match` matches on `parsed.path`
(`reel_url.py:18`), so the query string never reaches the regex. **The backend validator needs no
change and `reel_filter.py` needs no redirect resolver.**

**The residual blind spot, and why it is already handled.** Three samples establish the dominant
form, not every form. `/share/reel/…` demonstrably exists in the wild — `frontend/lib/trip/`
`parse-inspiration.ts:32` carries a `(?:share\/)?` branch plus `m.` and `p|tv`, and nobody writes
that speculatively. A human can still paste a link they obtained some other way. That case needs no
speculative machinery here because **T4 already logs `telegram_reel_unsupported_url` at ERROR with
the sanitized path shape and withholds the ✅** — the blind spot is instrumented rather than guessed
at. If `/share/` shapes actually show up in the logs, add the resolver then, against evidence.

**Prior art for T2, previously unrecorded in this plan:** `parse-inspiration.ts:32-39` is the closest
existing implementation of the function T2 must write. Read it before writing `reel_filter.py` —
**but do not port it wholesale.** It is deliberately more permissive than the backend, and two of its
behaviours are wrong for the bot: it rewrites `share/reel/CODE` → `/reel/CODE/` on the *unverified*
assumption that a share code is the reel shortcode, and it emits `/p/` and `/tv/` URLs that
`capture_saved_reel` (`saved_reels.py:9`) rejects with `ValueError`. T2 delegates to
`normalize_reel_url` precisely so the bot cannot inherit either.

**Filed separately, not this plan's scope:** the frontend accepts `p|tv` and preserves the type
(`parse-inspiration.ts:37-38`), so an Instagram *post* link passes client validation and then fails
server-side in `capture_saved_reel`. A live frontend/backend divergence — raise with Zhi Hao.

### T1 — `api.py`

Client is a required keyword (one long-lived `AsyncClient`, `timeout = poll_timeout + 15`, because
long polling holds the socket). **The bot token is in the URL path**, so every raise goes through
`_safe(exc)` that rebuilds the message from method + status only. 429 → parse
`parameters.retry_after` → `TelegramRetryAfter`.

**[IMPL 2026-08-02] `from None`, not merely the absence of `from exc`.** Rebuilding the message is
necessary but **not sufficient**. Python sets `__context__` *implicitly* on any exception raised
inside an `except` block, and `traceback.format_exception` prints implicit context exactly as it
prints an explicit `__cause__` — so a bare `raise _safe(method, exc)` still puts the URL-bearing
httpx exception, token and all, in the formatted traceback. The correct form is
`raise _safe(method, exc) from None`, which sets `__suppress_context__` and drops both chains.
Proven by fault injection (a bare `raise` reddens the traceback test) and reproduced independently
by the reviewer outside the implementer's harness.

**[IMPL 2026-08-02] CORRECTION — the `ConnectError` leak claim below was empirically FALSE.**
`str(httpx.ConnectError("boom", request=req))` is exactly `"boom"`, and a propagating
`ConnectError`'s traceback carries no URL. A test resting on that premise would have been **false
coverage** — the sixth shape on BUILD-LOOP's "tests that cannot fail" list, asserted here for eight
review rounds because it *sounds* right and nobody constructed the object. The real leak vector is
**`httpx.HTTPStatusError`**, whose `str()` is the token-bearing URL in the exact form
`raise_for_status()` builds (`Client error '400 Bad Request' for url '<url>'`). The shipped tests
use that instead; the `ConnectError` test remains red-on-delete via `pytest.raises(TelegramAPIError)`,
which is a different guarantee than the one originally claimed.

**RED when:** `_safe` is removed (token `SECRET123` appears in `str(exc)`); the `httpx.HTTPError`
branch is removed (a raw `ConnectError` then propagates and is not a `TelegramAPIError`); the
`from None` is removed (an `HTTPStatusError`'s URL reappears in the formatted traceback via implicit
`__context__`); the `retry_after` parse is removed.

### T2 — `reel_filter.py` — the only function that reads message text

**[R5/M2] A structured result, not a bare tuple.** Rev 5 declared `-> tuple[str, ...]` here while T4
expected `(urls, unsupported_count)` — a contradiction, and a count cannot supply the sanitized path
shape T4 needs to log without re-reading message text *outside* this module, which is the one thing
the single-reader rule forbids.

```python
@dataclass(frozen=True, slots=True)
class FilterResult:
    urls: tuple[str, ...]              # normalized, order-preserving, deduped
    rejected_shapes: tuple[str, ...]   # sanitized PATH SHAPES of Instagram-looking URLs that
                                       # failed normalize_reel_url, e.g. "/share/reel/…", "/p/…".
                                       # NEVER the URL, the code, or any surrounding text.
    truncated: bool                    # [R6/m2] True when the 10-URL cap discarded valid reels.
                                       # Without this, an 11-reel message ingests 10 and still
                                       # gets a ✅ claiming every reel was accepted.

def extract_reel_urls(message: dict) -> FilterResult:
    """Normalized IG reel URLs from one Telegram message, plus the shapes we had to reject.
    Pure: no I/O, no LLM, no network, stdlib + scrape.reel_url only."""
```

A candidate on an `instagram.com` host that `normalize_reel_url` rejects contributes its path shape
to `rejected_shapes` (first path segment(s), with any code/slug replaced by `…`). A non-Instagram
URL contributes nothing — it is ordinary chat.

Read `text`+`entities`, then `caption`+`caption_entities`. Nothing else. >100 entities → empty.
`type=="url"` → slice by **UTF-16 code units**
(`text.encode("utf-16-le")[off*2:(off+len)*2].decode("utf-16-le")`) — Telegram offsets are UTF-16,
so one emoji before a URL breaks Python-character slicing, and 📍-prefixed captions are the target
case. `type=="text_link"` → `entity["url"]` verbatim. All other types ignored.

**[R6/m1] Constructing the result** (rev 6 left a stale "`ValueError` dropped … return a tuple"
sentence here that contradicted the dataclass above): each candidate goes through
`normalize_reel_url`. On success it joins `urls`. On `ValueError` it is **not** silently dropped —
if its host is `instagram.com` its sanitized path shape joins `rejected_shapes`; otherwise it is
ordinary chat and contributes nothing. Then dedupe `urls` order-preserving; if more than 10 survive,
keep the first 10 and set **`truncated=True`**. Return `FilterResult(urls, rejected_shapes,
truncated)`.

**Entities, not a regex** — the entity list is Telegram's own parse; a hand-rolled scanner means
parsing untrusted content (guardrail #11) plus a ReDoS/obfuscation surface.

**[IMPL 2026-08-02] The exception that must never escape carries the chat content.**
`normalize_reel_url` raises `ValueError(f"not an Instagram reel URL: {url!r}")` — **the message IS
the candidate URL**, which is untrusted group content. This module swallows that `ValueError`, but
anything raising *inside* that handler attaches the leaky exception as implicit `__context__`, and a
caller's `logger.exception(...)` prints the whole chain — chat content straight into the log.
`urlparse("https://[::1/reel/A")` raises `ValueError: Invalid IPv6 URL` **from inside the very
handler holding the leaky exception**, so this is a live trigger, not a theoretical one. Guarded by
having the host test and the shape builder each catch `ValueError` internally, and asserted by a
test on the *formatted traceback* rather than on `str(exc)`. Same `__context__` mechanism as §T1's
`from None` finding, different asset class: a credential there, untrusted content here.

**[IMPL 2026-08-02] Sanitized shapes are lowercased, not echoed verbatim.** An earlier wording kept
a matched keyword segment with its original casing, which makes `/rEeL/` and `/reel/` distinct
shapes — an attacker-controlled channel into T4's ERROR log, and a way to fill the 10-shape cap with
case variants of one keyword. The keyword vocabulary is a closed 7-word set, so lowercasing loses
nothing.

**The contract:** everything downstream sees only strings matching
`^https://www\.instagram\.com/reel/[A-Za-z0-9_-]+$`. Never stored, never logged, never passed on:
`text`, `caption`, failed slices, `from.username`, `from.first_name`, `chat.title`.

**RED when:** UTF-16 slicing becomes Python slicing (`"🇯🇵🔥 look https://…/reel/ABC123/"` captures
nothing — **the highest-value test here**); the `text_link` branch is removed; the
`normalize_reel_url` gate is removed; the host check weakens to `in url`
(`instagram.com.evil.com/reel/A` passes); the caps are removed; **the caplog canary** — a message
containing `CANARY-SECRET` and a `text_link` url `https://x/?token=abc` reaches any log record.

### T3 — `config.py`

Frozen dataclass. Validation mirrors `config_validation.validate_required_secrets` — raises naming
**every** missing/invalid var at once, names never values, blank counts as missing, called *before*
the broad try at boot. **Fails CLOSED on an empty allowlist**: unset or empty
`TELEGRAM_ALLOWED_CHAT_IDS` is a boot failure, not "accept everything" — the worst failure mode is
the bot being added to a random group and ingesting it. A non-integer entry raises rather than being
skipped. Negative ids (supergroups) parse. `ASTRAIL_INGEST_USER_ID` must parse as a UUID.

### T4 — `ingest.py::handle_update`

1. `update.get("message")` only — `edited_message` / `channel_post` / `my_chat_member` ignored (an
   edit re-triggering ingestion is a free duplicate-spend path).
2. `chat.type in {group, supergroup}` **and** on the allowlist → else **silent**, logged once per
   chat per process with `chat_id` only. Never reply to an unknown chat.
3. `result = extract_reel_urls(message)`. **[R4/M1 + R5/M2]** Empty `urls` **and** empty
   `rejected_shapes` → silent (~99 % of group traffic). **Any non-empty `rejected_shapes` → log
   `telegram_reel_unsupported_url` at ERROR** with the chat id and the path shapes only, never URL
   content — **regardless of whether the message also contained valid URLs.** That is the T0 spike's
   blind spot surfacing in production instead of vanishing into a `ValueError` swallow.
4. Per URL, each wrapped so one URL's failure never touches the next (guardrail #3):
   - `capture_saved_reel(client, INGEST_USER_ID, url)` — idempotent upsert (`saved_reels.py:7`).
   - `create_organize_job(client, INGEST_USER_ID, [saved_reel_id])` — **single item**, so idempotent
     while active (F1).
   - `queue.put_nowait(job_id)` — `QueueFull` → log WARN and move on; the web reaper picks it up.
   - **Any caught exception → `telegram_reel_dropped` at ERROR**, and this URL is not durable.
5. **React ONCE per message, and only when the message is wholly clean.** ✅ requires **all three**:
   `rejected_shapes` empty, **`truncated` False** (**[R6/m2]** — otherwise an 11-reel message
   ingests 10 and still claims all were accepted; a truncation also logs ERROR), and every URL in
   `urls` durable. Rev 4 reacted per URL (so a partial
   failure still looked accepted); **[R5/M2]** rev 5 still ticked a message that mixed a valid
   `/reel/ABC` with an unsupported `/share/reel/XYZ`, because the reaction condition only considered
   valid URLs. Both are wrong against the pinned promise. Absence of a tick is the signal.
   `set_message_reaction(...)` is best-effort; **[R5/m1] log a reaction failure at WARN** so a
   missing ✅ is diagnosable — a swallowed reaction error is indistinguishable from a real rejection,
   and a needless re-share creates a duplicate job (harmless: `create_organize_job`'s idempotency
   branch covers only `initializing`/`pending`/`processing`, so a *completed* job is not returned —
   but the re-run is a cache hit with zero Apify/OpenAI charge).

**The human contract, stated in the group's pinned message:** *"✅ means every reel in that message
was accepted. No ✅ means re-share it or ping the operator."* Without this convention "the human
re-shares" (§3.1) is wishful thinking rather than a recovery path.

**[R4/m2] No special-casing of `ActiveOrganizeConflict`.** Rev 4 caught AS409 and treated it as
accepted. For single-item jobs it is unreachable (F1) — but *if* it ever fires from key drift or
another caller, the claim "the reaper guarantees it runs" is false: the SQL counts `initializing` as
active (`20260720130000:73`) while `recover_organize_jobs` lists only `pending`
(`organizer.py:374`). So an unexpected AS409 takes the normal per-URL ERROR path and gets **no ✅**.

**No `send_message` anywhere**, so there is nothing to throttle and no `throttle.py`.

**RED when:** the allowlist check moves after any write; `edited_message` is handled; a batch of >1
saved_reel_id is ever passed to `create_organize_job` (that would resurrect AS409 — see F1); a
`QueueFull` is treated as a failure; one URL's exception aborts the next; **a caught per-URL failure
produces no ERROR log** (the silent path round 4 found); **an unsupported Instagram URL is dropped
without an ERROR**; **a message with one failing URL still gets ✅**; a reaction failure aborts
ingestion.

**[R5/M2] The mixed-message RED test, named explicitly because two rounds missed this case:** a
single message containing `https://www.instagram.com/reel/ABC` **and**
`https://www.instagram.com/share/reel/XYZ`. Assert the valid reel becomes durable, an ERROR names
the `/share/reel/…` shape, and **no ✅ is sent**. RED if the reaction condition looks only at
`urls`, or if `rejected_shapes` is only consulted when `urls` is empty.

### T5 — `poller.py`

Offset advances to `max(update_id)+1` **only after every update in the batch has been handled**. A
crash before that → Telegram redelivers within 24 h into idempotent upserts. A per-update exception
is caught, logged at **ERROR**, and the offset **still advances** — the deliberate loud drop of §3.1.

Backoff `1,2,4,…,60 s` ±20 % jitter, reset on first success. `TelegramRetryAfter` → sleep
`retry_after + 1`. **409 Conflict** special-cased at ERROR — two worker instances, a Render scaling
misconfiguration, not a transient. `telegram_poller_alive` heartbeat on a 60 s **minimum**
interval — checked once per loop iteration, so the real cadence is ~100 s at the deployed 50 s long
poll, with the FIRST beat fired at loop entry so a fresh deploy announces itself at once
([IMPL 2026-08-02]; T10 step 5) — substituting for
the `healthCheckPath` a worker cannot have.

**RED when:** the offset advances before the batch is handled; it uses `len(updates)` instead of
`max(update_id)+1`; the backoff reset is missing (permanent 60 s polling after one blip); a
per-update exception escapes and kills the loop; a per-update exception is swallowed **silently**
(it must be ERROR — §3.1 depends on that).

### T6 — `worker.py`

1. `validate_required_secrets()` — reused verbatim.
2. `load_telegram_config()`.
3. **Both before the broad `try`** — a config error is fatal, a DB blip is not.
4. **One probe:** `select id from public.users where id = <ingest_user_id>`. A wrong or absent UUID
   fails boot instead of failing on every reel. No RPC probe and no column probe are needed —
   **the worker code reads neither** (see T7).
5. Consumer task: `await queue.get()` → `run_organize_job(job_id, INGEST_USER_ID, client=client)` in
   a try/except. **One consumer = concurrency 1**, no semaphore object.
6. SIGTERM → stop polling, drain the queue with a deadline, exit 0. Anything still in flight holds a
   lease that expires in ≤300 s and is reclaimed by the **existing** web reaper.

### T7 — Migration A: the per-account analysis limit

`reserve_organize_item_analysis` hardcodes `< 5` (`20260719101000:~80`), so the shared ingest
account would cap at 5 reels/day for *all* Telegram users combined.

```sql
alter table public.users
  add column daily_reel_analysis_limit integer not null default 5,
  add constraint users_daily_reel_analysis_limit_range
    check (daily_reel_analysis_limit between 1 and 10000);

create or replace function public.reserve_organize_item_analysis(p_item_id uuid, p_user_id uuid)
returns date ...   -- SIGNATURE UNCHANGED; body identical except the limit:
--   where usage.reel_analysis_count
--         < coalesce((select u.daily_reel_analysis_limit
--                       from public.users u where u.id = p_user_id), 5)
```

A **column, not a parameter**: a third argument would force dropping the 2-arg function (PostgREST
otherwise hits "function is not unique"), opening a `PGRST202` window on the live organize path. It
is also *wrong* — the limit must follow the **account**, since the web reaper may run an ingest job.
Codex confirmed across two rounds that `CREATE OR REPLACE` is correct here, no drop needed. A single
`coalesce(...)` replaces rev 3's `select into` + `if not found`, and is provably identical for every
existing user.

**[R3/B4] Re-assert the full privilege contract in the same migration** — `security definer`,
`set search_path = ''`, `revoke all … from public, anon, authenticated`,
`grant execute … to service_role`. `create or replace` preserves them, but stating and asserting
them is what stops a future edit silently dropping one.

Note: `grant select on public.users to authenticated` (`20260701131304:165`) means a user can read
their own limit. Harmless; stated so it isn't discovered as a surprise.

**pgTAP → RED when:** the default changes (a default user gets 5 then `null` on the 6th — the
byte-for-byte proof); the `coalesce` fallback is removed (a missing `users` row raises and fails an
item mid-job); a raised limit doesn't grant N; the reserved-item short-circuit is disturbed;
`has_function_privilege('authenticated', …)` becomes true.

### T8 — Rollback for Migration A

`supabase/migrations/rollback/` holds only the `20260720100000` pair. Add and **host-test**:
restore the old `< 5` body **first**, then drop the constraint and column — that order, because the
reverse leaves a function referencing a dropped column for one statement. Test host-side:
`supabase test db` cannot reach `rollback/`, and testing a *copy* is how a divergent script ships
green (`BUILD-LOOP.md`).

**Because no code reads the column (T6), the rollback needs no code coordination.**

### T9 — `render.yaml`, ENV.md, STACK.md

**No new env var on the web service, and no Python change.** Dockerfile unchanged — one image;
`dockerCommand` overrides `CMD` per service.

**[R4/B2] One deliberate edit to the `astrail-backend` block: add `branch: dev`.** Rev 4 claimed
Phase 1 left the web service byte-identical. **That was false.** The web block has no `branch:`
today (`render.yaml:3-10`) — its `dev` tracking lives only in the Render dashboard. A Blueprint
**configuration sync** applies the Blueprint to every service it names, and an omitted `branch`
falls back to the repository default (`main`); `autoDeploy: false` governs *commit-triggered*
deploys, not a config sync. So syncing the Blueprint to add the worker could retarget
`astrail-backend` from `dev` to `main`, or trigger a configuration deploy — against a `/health`
that performs no schema check.

Adding `branch: dev` **pins what is already true**, so it is a no-op against the running service and
closes the drift. Belt and braces, both required in the runbook:
1. `branch: dev` explicit on the web block.
2. **The Blueprint preview must show the new worker as the ONLY change.** If it shows any diff on
   `astrail-backend`, stop and create the worker manually in the dashboard instead.
3. After the sync, explicitly verify no web deploy or configuration change occurred.

```yaml
  - type: worker
    name: astrail-telegram-ingest
    runtime: docker
    repo: https://github.com/MalaysiaKaki/astrail
    branch: dev                 # REQUIRED — an omitted branch defaults to the repo default
                                # (main), whose image may lack telegram_ingest. The web
                                # service's dev tracking lives in the dashboard, not here.
    region: singapore
    plan: starter
    numInstances: 1             # two getUpdates consumers is a hard 409
    dockerfilePath: ./Dockerfile
    dockerCommand: sh -c "cd backend && exec python -m telegram_ingest.worker"
    autoDeploy: false           # same reason as astrail-backend
    maxShutdownDelaySeconds: 120
    envVars:
      - OPENAI_API_KEY / APIFY_TOKEN / MAPBOX_SECRET_TOKEN   # Mapbox: needed by _ground_place
      - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
      - TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_CHAT_IDS / ASTRAIL_INGEST_USER_ID
```

**Deliberately absent, verified by grep:** `MEM0_API_KEY` (the organize path never touches mem0);
`LANGFUSE_*` (`pipeline/tracing.py`'s default tracer is a no-op, nothing imports langfuse);
`SUPABASE_JWT_SECRET`, `ALLOWED_ORIGINS`, `DAILY_TRIP_QUOTA`, `BURST_LIMIT`, `PORT` (no inbound
HTTP). Update `.env.example`, `.claude/docs/ENV.md` (a "Worker-only" subsection), and **`STACK.md`**
— Telegram is a new service in the frozen stack and needs an explicit row.

### T10 — Two-phase release (this is the deployment-safety story)

> **[IMPL 2026-08-02] PRE-DEPLOY GATE — verify a prerequisite this branch INHERITS.**
> **Before Phase 1, confirm the deployed Supabase database has every migration applied through
> `20260731120000_reel_cover_bucket`.** This is not something this branch creates; it is something
> this branch is the first thing to *depend on*. The worker's first job calls
> `claim_organize_job`, introduced in `20260720170000_db_clock_job_leases.sql` (part of the Saved
> Reels arc, merged to `origin/dev` — the files exist). If the deployed database is behind, the
> worker boots, `_probe_ingest_user` passes, `telegram_poller_alive` fires, `/health` stays green,
> and **every single job fails** — the exact "looks alive, ingests nothing" state this feature's
> two loudest guards exist to prevent, arriving through a door neither of them watches.
> Nothing on a developer machine can check this: local `supabase db reset` proves only that the
> files apply to an empty database. Someone must look at the deployed database. `.claude/docs/STACK.md`
> now states why — **schema is applied by hand and code ships on merge, in either order.**

**Because no code reads `daily_reel_analysis_limit`, the schema and the code are fully decoupled.**
That deletes the entire ordering-trap class rev 3 spent a section on.

```
PHASE 1 — ZERO MIGRATIONS
  0. [R5/M1] BEFORE MERGING render.yaml, in the Render dashboard confirm:
       - whether a Blueprint already manages astrail-backend, and which branch
         it tracks;
       - that Blueprint AUTO SYNC IS DISABLED.  <-- HARD GATE, not advisory.
     `autoDeploy: false` governs the SERVICE's commit-triggered deploys; Blueprint
     Auto Sync is a SEPARATE setting that syncs added/modified resources on a push
     touching the Blueprint, and can redeploy affected services. With Auto Sync ON,
     merging this PR would create the worker automatically -- and per step 4 an
     existing Blueprint IGNORES `sync: false` prompts, so it would start with empty
     variables and crash-loop. It could also apply web-service config changes with
     no review.
     If Auto Sync cannot be disabled: do NOT merge render.yaml yet. Create the
     worker by hand first (step 4), then merge the blueprint change afterwards as
     documentation-of-record.
     Note the worker is created by hand in EITHER case (step 4); this gate exists
     to protect `astrail-backend` and to stop an empty-env worker being created
     out from under the sequence.
  1. Supabase dashboard -> Auth -> Add User (this IS GoTrue, so the
     on_auth_user_inserted trigger fires and creates public.users).
     NEVER insert into auth.users directly.  Record the uuid.
  2. BotFather: create bot; ADD to the group; PROMOTE TO ADMINISTRATOR;
     capture the chat id; deleteWebhook.
     [IMPL] PIN THE HUMAN CONTRACT IN THE GROUP. Not optional, and not a nicety:
     §3.1 accepts LOSS on the argument that "a human re-shares", and the ONLY
     thing that turns that from a hope into a recovery path is group members
     knowing that a missing tick means re-share. Nobody knows that by default —
     an unreacted message looks exactly like a bot that is a little slow. Until
     this is pinned, the loud-drop design has no host surface and the feature is
     lossy in practice however loud the logs are. Post this in the group and pin
     it (verbatim; the second line is the load-bearing one):

       Astrail reel bot 🤖
       Paste Instagram reel links here and I'll add them to our trip research.
       ✅ on your message = every reel in it was accepted.
       No ✅ = something was rejected. Re-share the link, or ping the operator.
       One message can hold several links. If only some were bad, you get no ✅
       — re-share the whole message.

  3. Merge the code PR.
  4. [R6/B2] CREATE THE WORKER WITH ITS SECRETS ALREADY PRESENT.
     Rev 6 correctly warned that a worker created before its `sync: false` secrets
     exist will boot and crash-loop -- config validation is deliberately FATAL and
     runs before the broad try (T6 step 3) -- and then sequenced sync BEFORE
     setting env vars anyway. A manual sync changes WHEN reconciliation happens;
     it does not stage secrets.
     [R7/B2] CREATE IT IN THE DASHBOARD. There is no Blueprint alternative for the
     FIRST creation, and rev 6's "sync, then immediately suspend, then set secrets"
     was not a fix: Render prompts for `sync: false` values only during INITIAL
     Blueprint creation; adding a service to an EXISTING Blueprint ignores them.
     The worker's first deploy therefore starts at once with empty variables and
     the fatal config validation exits before anyone can suspend it. "Immediately
     suspend" is not an atomic pre-start gate.
       - Create `astrail-telegram-ingest` in the dashboard, entering all eight
         values BEFORE creation completes, and only then let it start.
       - The resource can be ADOPTED into the Blueprint afterwards, once it exists
         and its secrets are set.
       - The render.yaml worker block is therefore documentation-of-record on first
         deploy and the source of truth thereafter. `branch: dev` on the WEB block
         (T9) still matters -- that is about protecting the existing service from a
         later sync, which is a separate concern from creating this one.
     GATE before first start, all present: TELEGRAM_BOT_TOKEN,
     TELEGRAM_ALLOWED_CHAT_IDS, ASTRAIL_INGEST_USER_ID, SUPABASE_URL,
     SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, APIFY_TOKEN, MAPBOX_SECRET_TOKEN.
     A crash-loop here is loud and harmless, but it wastes the deploy window and
     looks like a code fault.
  5. Start the worker. Expect `telegram_poller_alive` IMMEDIATELY — it is the
     first thing the poll loop does — and then roughly every 100 s.
     [IMPL 2026-08-02] Both halves were wrong before and both are now pinned by
     tests. The cadence is NOT 60 s: the interval constant is 60 s but the beat is
     checked once per loop ITERATION, and one iteration is one full 50 s long
     poll, so beats land at ~100 s spacing. That alone would have made this step a
     100-second stopwatch exercise, so `last_beat` starts one interval in the past
     and the FIRST beat fires at loop entry — which is what makes this check a
     glance. If nothing appears within ~10 s of the process reaching the poll
     loop, the INFO root level did not take effect (see checklist item 5).
     See `_HEARTBEAT_INTERVAL_S` and `last_beat` in `poller.py`,
     `test_the_first_beat_fires_at_loop_entry_before_the_first_poll` and
     `test_the_real_idle_cadence_is_the_interval_rounded_up_to_a_poll`.
     [R8/m3] ASSERT THE WORKER'S LIVE SHA equals the merge SHA from step 3. Dashboard
     creation builds from the tip of `dev`, and if `dev` advanced between the merge
     and the creation the worker runs a LATER commit while its heartbeat passes
     happily. A heartbeat proves liveness, not version.
     If the Blueprint was synced, verify no web deploy or config change occurred.
  6. Smoke (T11).
  -> Works immediately, capped at 5 cold reels/day by the EXISTING hardcoded
     limit. That is the ceiling you want on day one, not a bug.
  -> ROLLBACK = suspend the worker. No schema state to revert.
  -> [R5/M1] The web service's RUNTIME is unchanged -- no Python, no env var, no
     behaviour change. It is NOT untouched in the repo: T9 adds `branch: dev` to
     its block. That line pins what the dashboard already says, so it is a no-op
     against the running service, but the earlier "no render.yaml line in its
     block" claim was false and is withdrawn.

PHASE 2 — ONE MIGRATION + ONE DATA UPDATE, no code change, days later
  7. Apply Migration A against already-running code, BY HAND and in ONE
     TRANSACTION:
       psql "$PROD_DB_URL" -X -1 -v ON_ERROR_STOP=1 \
         -f supabase/migrations/20260802120000_per_account_reel_analysis_limit.sql
     [IMPL 2026-08-02] `-1` is not stylistic. Without it psql autocommits each
     statement, so a failed `alter table` — the file's own 3 s lock_timeout
     firing is the realistic way — does not stop the file, and the
     `create or replace function` below then installs a body referencing a
     column that does not exist, on the path every website organize run takes.
     Demonstrated against a real database in both directions; the file's header
     carries the measurement and explains why an in-file `begin;/commit;` is
     WORSE rather than tidier.
  8. RAISE THE LIMIT. [R4/B1] The migration defaults every user to 5, and the ingest
     account already exists, so it gets 5 like everyone else. Without this step
     Phase 2 changes NOTHING and reel 6 still fails "analysis quota reached".
         update public.users
            set daily_reel_analysis_limit = 100
          where id = '<recorded-ingest-user-uuid>'
      returning id, daily_reel_analysis_limit;
     Assert EXACTLY ONE row came back before testing.
  9. Verify a 6th cold reel now succeeds.
  -> ROLLBACK = T8's down script, with no code coordination.
```

**[R4/B1] Why this step nearly went missing.** Rev 3 had a `bootstrap_ingest_account.py` script;
rev 4 deleted it as "a once-ever operation, two runbook lines". The account creation was indeed
trivial — but **the limit-raising `UPDATE` inside it was load-bearing**, and deleting the script
deleted the only place it appeared. Round 4 caught it at confidence 10/10. Simplification can drop a
step that was carrying real weight; this is the one that did.

### T11 — Live verification

- **Phase 0 — free, non-mutating, highest value.** `getMe`; per allowlisted chat `getChat`, then
  **`getChatMember(chat_id, bot_id)` asserting `status == "administrator"`**. Without admin,
  privacy mode hides plain URL messages and the bot sees *nothing at all, with no error anywhere* —
  indistinguishable from "never deployed". This one assertion is the difference between "broken" and
  "broken and we know why in 3 seconds." Also run it at boot as a WARNING (not fatal — a Telegram
  blip must not block boot).
- **Phase 1 — spends credits, the real proof.** A human drops ONE known reel; poll 180 s and print,
  in `live_run.py --inspect` style: `saved_reels` → `organize_jobs` + status → `organize_events` in
  sequence → `reel_cache` (`extractor_version`, did `extracted_places` land) → `reel_place_mentions`
  → resulting `places` with lat/lng/country. `--cleanup` removes the `saved_reels` row and the job
  but **keeps `reel_cache`, `geocode_country_cache` and `places`** — the kept caches *are* the
  deliverable.
- **Phase 2 — free, the thesis.** A *second* Telegram user drops the *same* URL. Assert
  `user_daily_usage.reel_analysis_count` for the ingest user **did not increase**. One command,
  the whole value proposition.

`reel_filter` fixture replay is a **unit test**, not a smoke phase.

#### [IMPL 2026-08-02] Deploy-day checklist — the proofs no test can give

Every item below was accumulated during implementation as "QA debt": a claim the unit suite
asserts against fakes and **only the real image, the real library and the real Telegram can
settle**. They lived in the SDD ledger, which `.gitignore:51` excludes, so they would have died
with the workspace — the single strongest finding of the final review. They are here now because
this file is the one that survives. Run them in order; none costs more than a minute.

1. **No `telegram_bot_not_admin` in the boot log.** If it appears, the bot is not a group
   administrator and Telegram's privacy mode will hide every plain-URL message: the deployment is
   indistinguishable from one that never happened (risk #2). Promote the bot, restart.
2. **One reel round-trips end to end and earns a ✅.** The T11 Phase 1 smoke above, in the real
   group, by a real human. The tick is the whole human contract; nothing else proves it fires.
3. **★ `grep 'api.telegram.org/bot' <deploy logs>` → ZERO hits.** THE credential proof. A Render
   worker has no uvicorn, so `_configure_logging` must raise the root logger to INFO or the
   heartbeat disappears — but httpx logs `HTTP Request: POST <url>` at INFO and the **bot token is
   in that URL path**, ~1700 lines a day each carrying a live credential into Render's log
   retention. `worker._NOISY_TRANSPORT_LOGGERS` pins httpx to WARNING. Unit tests assert this
   against a fake; only this grep proves it holds against the real httpx in the real image.
4. **★ `grep 'apikey=' <deploy logs>` → ZERO hits.** The same proof for the service-role key.
   `acreate_client` constructs an `AsyncRealtimeClient` on every boot whose URL is
   `wss://…?apikey=<SERVICE_ROLE_KEY>`. The `realtime` pin closes the DEBUG door; what actually
   keeps the key out today is that nothing calls `.channel()`/`.subscribe()`. Both halves are
   invisible to a unit test.
5. **`telegram_poller_alive` observed at its real interval** — the first beat lands as soon as the
   poll loop starts, then ~every 100 s (T10 step 5; do NOT expect 60 s). Its ABSENCE in the first
   seconds is the failure signal, which is why the entry beat exists: it turns this from a
   100-second stopwatch into a glance. This is the ONLY check that the INFO root level
   and `force=True` actually took effect in the real image. If it is missing, every INFO event this
   feature emits is invisible and the service has no liveness signal at all.
6. **A deliberately wrong `TELEGRAM_BOT_TOKEN` produces `telegram_poll_unauthorized` at ERROR** —
   not `telegram_poll_error` at WARNING — and the message names the env var. A 401 never clears on
   its own; at WARNING it is indistinguishable from the network blips around it, and the worker
   would look healthy on every dashboard forever while ingesting nothing. Restore the real token
   afterwards.
7. **A redeploy shows `telegram_worker_draining` → `telegram_worker_stopped` with a NON-CRASH exit
   status.** SIGTERM → stop polling → drain → exit 0. A non-zero exit makes Render report a crash
   on every routine deploy, which is how real crashes stop being noticed.

Items 3, 4 and 6 need the operator to look at raw logs, not a dashboard summary. Item 6 mutates
configuration — do it last among the log checks, and confirm the real token is back before item 7.

### Observability

Structured stdout, snake_case, `key=value` (the repo's existing style; Render captures stdout).
Every string field is a scalar or a normalized IG URL, pinned by T2's caplog canary.

**[IMPL 2026-08-02] The shipped event list**, reconciled against the code — an operator grepping
for a documented event that does not exist wastes the time this section exists to save. Notably
`telegram_job_created` was **never implemented**: it was folded into `telegram_reel_accepted`,
which is emitted at the T4 acceptance gate and already carries the job id, so a second line per
reel said the same thing twice. Do not grep for it.

| Where | Events |
|---|---|
| Liveness | `telegram_poller_alive` (the no-healthcheck substitute — **immediate at loop entry, then ~100 s cadence; see T5**) · `telegram_worker_starting` · `telegram_ingest_user_ok` · `telegram_worker_draining` · `telegram_worker_stopped` · `telegram_poller_stopped` |
| Poll transport | `telegram_poll_error` (WARNING, transient) · `telegram_poll_conflict` (ERROR — two `getUpdates` consumers) · `telegram_poll_unauthorized` (ERROR — a wrong/revoked token, added after T6 review) · `telegram_poll_unexpected` (ERROR — unclassified) · `telegram_poll_offset_unresolved` (ERROR) |
| Per reel | `telegram_reel_accepted` · `telegram_reel_dropped` (ERROR — §3.1) · `telegram_reel_unsupported_url` (ERROR) · `telegram_reel_truncated` (ERROR) · `telegram_reel_entities_overflowed` (ERROR) · `telegram_reel_filter_failed` (ERROR — a T2 regression) · `telegram_queue_full` · `telegram_reaction_failed` (WARNING) |
| Per job | `telegram_job_failed` (ERROR — `run_organize_job` RAISED) · `telegram_job_reported_failed` (ERROR — it returned `status="failed"`; two distinct diagnoses, do not fold them) |
| Boot / shutdown | `telegram_bot_not_admin` (WARNING — risk #2) · `telegram_admin_check_failed` (WARNING) · `telegram_chat_rejected` · `telegram_update_failed` (ERROR) · `telegram_drain_deadline_exceeded` (WARNING) · `telegram_worker_poller_failed` · `telegram_worker_consumer_failed` |

**No PostHog** (declared in `pyproject.toml`, imported nowhere) and **no Langfuse** (no-op tracer).
**No `ingest_report.py`** — three runbook SQL queries: `saved_reels` per day for the ingest user;
`user_daily_usage.reel_analysis_count` (**`cold_reel_analyses`** — this counts cold reel analyses,
*not* hosted web-search calls, since one run can issue several per `_count_web_searches`,
`place_extractor.py:286`); `organize_jobs` by status. Write the script the third time you run them
by hand.

The ✅ reaction is itself a liveness signal a human sees without opening a dashboard.

## 6. Relationship to PLAN B — sequencing only

Round 3 caught that rev 3's "PLAN A MUST call `find_or_create_place` with `p_aliases`/`p_lookup_keys`"
was **an uncounted live-path change hiding in a cross-plan contract**: those parameters don't exist
yet, and ingest reaches that RPC only *through* `backend/grounding.py:173`, which every web organize
run also uses. **That change belongs entirely to PLAN B.**

PLAN A's dependency is therefore only sequencing: *if* you want this corpus to feed PLAN B's probe,
land PLAN B's T1–T2 first. PLAN A's own diff requires nothing from PLAN B.

## 7. What is genuinely lost (stated, not hidden)

| Lost | Matters? |
|---|---|
| Per-Telegram-user quota and DB attribution | **No.** Bounds that remain: the chat allowlist (who), `daily_reel_analysis_limit` (paid spend, absolute), Telegram's own rate limits. `telegram_user_id` is logged. Account linking was already a deferral, and the table would be purely additive then |
| Worst-case flood by an allowlisted member | Re-dropping 5 000 warm URLs = 5 000 cache-hit jobs, **zero** Apify/OpenAI spend. For a private group of known humans, acceptable. If a bound is wanted, a 6-line in-process daily accept counter catches the realistic case (a bug loop) with no table |
| An exact requests-received-vs-completed ledger | **No.** `saved_reels` + `organize_jobs` status for the ingest user is the ledger |
| Isolating ingest recovery from the web dyno | **No.** ~0–3 runs/day, bounded at 3 concurrent, and `main.py:386` already runs `run_organize_job` in-process for every real web user. Buying the isolation cost a live-path refactor and a new bug class |
| Instant worker self-recovery | **No.** The web reaper picks up in ≤120 s (pending) or ≤~420 s (expired lease) |
| Batching | **No.** `run_organize_job` processes items sequentially (`organizer.py:703-712`), so batching bought zero throughput and cost the entire AS409 class |
| A URL lost if the worker is dead >24 h, or on a poison update | **Accepted and stated in §3.1.** Logged at ERROR; the human re-shares |

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | ~~Share-sheet URLs don't match `normalize_reel_url` → the bot silently accepts nothing~~ | **RETIRED 2026-08-02 — T0 measured it: 3/3 canonical `/reel/<code>/`, `?igsh=` dropped on `parsed.path`.** No resolver. A stray `/share/` shape logs ERROR and withholds ✅ (T4) rather than vanishing |
| 2 | **Bot is not a group admin (or gets demoted)** — privacy mode hides every plain URL, no error, no log | T11 Phase 0 asserts `administrator`; boot logs it as WARNING; the heartbeat (immediate, then ~100 s — T10 step 5) distinguishes "polling fine, ingesting nothing" from "dead"; promotion is a numbered runbook step |
| 3 | **Migration A's `create or replace` on a shared user-facing function** — the one live thing this plan changes | Signature unchanged so no `PGRST202`; `coalesce(…, 5)` preserves every existing user byte-for-byte; pgTAP proves the 5-then-null boundary; applied in Phase 2 **against already-running code**, fully isolated from the worker; privilege contract re-asserted. **[R4/m3]** The `alter table … add column` is **no rewrite but NOT lock-free** — a constant default avoids the rewrite, but `ALTER TABLE` still takes a brief `ACCESS EXCLUSIVE` lock on `users`. Set `lock_timeout = '3s'` and `statement_timeout` so it fails fast rather than queueing behind a long read |
| 4 | Runaway paid spend | `daily_reel_analysis_limit` is charged **only on a `reel_cache` MISS**, so it bounds exactly the Apify + OpenAI calls. Warm reels are free and uncapped by design |
| 5 | Untrusted group text leaking into logs or downstream (#11) | `extract_reel_urls` is the single reader; everything downstream is typed to normalized URLs; the caplog canary fails if any module formats message text. **No message text ever reaches an LLM** — the extractor's only input is `scrape_reel`'s output for a validated URL, identical to the web path |
| 6 | Apify IG-block waves (known SPOF) | Per-item isolation (#3); `python -m scrape.probe_apify`; the spend cap bounds burn |
| 7 | An extraction hangs (no wall-clock timeout on `Runner.run`, `place_extractor.py:279`, while the organizer heartbeat can renew the lease indefinitely, `organizer.py:404`) | **Pre-existing and equally true on the live web path** — not introduced here. Logged as a deferral below rather than fixed in this plan |
| 8 | Higher-volume logged-out scraping shifts the legal posture | Volume is capped; a judgement call for Shaun + Zhi Hao, not a code fix |

## 9. Deferrals with triggers

| Deferred | Trigger |
|---|---|
| Wall-clock timeout on `Runner.run` (risk 7) | It bites on the **web** path too; fix it there, for both, when a hung extraction is actually observed |
| An in-process daily accept counter | An observed flood or bug loop |
| `telegram_ingest_requests` / per-user attribution | Account linking becomes real; purely additive then |
| Telegram↔Supabase account linking | Users ask "where did my reels go" |
| Batching / concurrency > 1 | Sustained backlog, which at 100 reels/day will not happen |
| `python-telegram-bot` | A *third* Bot API capability is needed |
| Webhook instead of long polling | >1 replica needed (two `getUpdates` consumers is a hard 409) |
| External heartbeat / worker liveness alerting | The worker dies and nobody notices for >12 h |
| Private-chat (DM) ingestion | Demand; one branch on `chat.type` |
| TikTok (`source_platform` already allows it) | A TikTok scraper exists |
| **Reaper task amplification under a queue overflow** (below) | A single reaper tick sees **>50 `pending` organize jobs**, or the web process's memory climbs across consecutive ticks |

#### [IMPL 2026-08-02] Reaper amplification — an accepted scope limit whose second-order cost we had not priced

Recorded, deliberately **not fixed**. Found by the arc's final Codex cross-model review, and it is
the one finding there that is neither wrong nor already covered: it is a real consequence of a limit
this plan accepts on purpose, and §8's flood row prices only the *provider spend*, not this.

The mechanism, verified against the code rather than reasoned:

- `worker._run` bounds the in-process queue at `queue_maxsize` (100). Beyond that, `QueueFull` is
  caught and the reel is **still durable** — its `organize_jobs` row exists — which is exactly the
  design: the queue is a latency optimization, and the existing web reaper owns recovery.
- `main._reap_loop` sweeps every `REAP_INTERVAL_S = 120`, and `organizer.recover_organize_jobs`
  returns **every** row with `status = 'pending'` — no `LIMIT` (`organizer.py:374-375`).
- The loop then does `_spawn(_redispatch_organize(...))` **per row**. The bound,
  `_RECOVERY_SEM = asyncio.Semaphore(3)`, is acquired *inside* `_redispatch_organize`, so it limits
  **execution, not task creation**: N pending rows create N tasks immediately, of which 3 run.
- A waiting task's job stays `pending` until it is actually claimed, so the **next** sweep selects
  the same rows and spawns a second task set, the one after that a third, and so on.

Consequence: an allowlisted member dropping thousands of warm URLs consumes **zero** Apify/OpenAI
credit (they are cache hits — §8's row is right about spend) but can accumulate tasks and memory in
the **web** process and starve the recovery path the whole website depends on. The per-account
analysis limit (T7) does not bound this: it caps *cold analyses*, not job rows.

Not fixed here for two reasons. It is **pre-existing** — the reaper behaves identically for any
source of pending jobs and this feature only makes a burst easier to produce — and the fix belongs
to the reaper, not to the bot: a `.limit()` on the pending select, sized to a few sweeps' worth of
throughput. Doing that inside a Telegram plan would change the recovery path every website organize
run depends on, on a branch reviewed for something else. **The 6-line in-process daily accept
counter already deferred above is the bot-side half**, and it is the cheaper of the two.

Watch it with the runbook query already listed under Observability (`organize_jobs` by status).

## 10. Revision history

| Rev | Score | What changed |
|---|---|---|
| 1 | 4.6/10 | Combined A+B. 4 blockers: kill switch, job stranding, capture gap, T2 signature |
| 2 | 5.2/10 | Split A/B; added a marker table, 2 quota RPCs, an age hatch, a reap refactor. 8 GENUINE / 5 PARTIAL / 2 NOT FIXED |
| 3 | 5.5/10 | Added `update_id` identity, a `waiting` state, a clock RPC, charge CHECKs. Codex: *"the added coordination machinery is now its largest deployment risk"* |
| 4 | 6.4/10 | **Deleted** the marker table, both quota RPCs, batching, the linger, the dedupe set, AS409 handling, the `waiting` state, the recovery split, the clock RPC, the `reaping.py` refactor, `throttle.py`, `authz.py`, `quota.py`, `bootstrap_ingest_account.py`, `ingest_report.py`. Two-phase decoupled release. **F1/F2/F3 verified TRUE**; verdict upgraded to NEEDS REVISION |
| 5 | 6.8/10 | Restored the load-bearing limit `UPDATE`; pinned `branch: dev`; loud-drop contract; dropped the AS409 special-case; lock wording. **No blockers remained** |
| 6 | 6.0/10 | `FilterResult` replaces the contradictory bare-tuple/count signature; **any** rejected Instagram URL logs ERROR and suppresses ✅ **even when the message also has valid reels** (the mixed-message hole); Blueprint **Auto Sync** verified disabled before merge, and the false "web is byte-identical in the repo" claim withdrawn; reaction failure at WARN |
| 7 | 6.5/10 | Non-optional resume in PLAN B; secrets-before-first-start gate; `truncated` flag; metadata sweep. **MAJOR: None.** Correctness 8.2 |
| 8 | **8.5/10 PASS** | Both runbooks REWRITTEN as sequences, not patched: PLAN B resumes **before** deploying (you cannot deploy to a suspended service — 409) and pins the worker's live SHA; PLAN A drops the Blueprint-first-creation path entirely (an existing Blueprint ignores `sync: false`, so "create then suspend" can never be atomic); Phase-2 renumbered; metadata reconciled. **Deployment safety 2.5 → 8.6 in one round.** No blockers, no majors |
| **9** | — | Folds round 8's three documentation-hygiene minors (explicitly non-blocking): PLAN B metadata corrected, its step 7 clarified as *run* not *update* pgTAP, and PLAN A's T10 step 5 gains the worker live-SHA assertion. **No design, sequencing, or scope change** — the 8.5 verdict was rendered on rev 8 and carries |

### Round-8 findings status — PASSING ROUND

Round 8: **8.5/10, READY TO IMPLEMENT.** Correctness 8.8 · Deployment safety 8.6 · Completeness 8.4 ·
Risk 8.8 · Clarity 7.8. **No blockers, no majors.** Verdict: *"The two deployment blockers and the
worker-version defect are genuinely fixed. The remaining items are documentation hygiene and
exact-version proof, not reasons to reopen the architecture or delay implementation."*

Three minors, all explicitly listed as NOT blocking, all folded into rev 9:

| Finding | Status in rev 9 |
|---|---|
| m1 — PLAN B's metadata still said rev 7 / rounds 1–6 / round 7 pending | **FIXED** — PLAN B header rewritten to rev 9 |
| m2 — PLAN B step 7 read "Update pgTAP … same PR as step 3", ambiguous about whether the tests are edited or executed at that point | **FIXED** — now `RUN pgTAP 012 + 015 (they were UPDATED pre-merge as part of step 3's PR, per 5.1a)` |
| m3 — a resumed/created worker's heartbeat proves liveness, not version | **FIXED** PLAN A T10 step 5 — assert the worker's live SHA equals the merge SHA, because dashboard creation builds from the tip of `dev` and `dev` may have advanced between the merge and the creation |

### Round-7 findings status

Round 7: **MAJOR None.** Two blockers, both mine, both in runbooks I had just edited.

| Finding | Status in rev 8 |
|---|---|
| B1 — PLAN B deploys while `astrail-backend` is suspended; Render returns 409, so the resume step is unreachable and the API stays down (conf 9/10) | **FIXED** PLAN B §5.5 — resequenced: the two RPC smokes prove the *old* code is compatible → merge → **resume** → deploy the merge SHA → **verify the live SHA equals it** → `/health` + `/readiness` + a DB-backed write → then the worker → then backfill |
| B2 — the Blueprint alternative cannot guarantee secrets before first start (conf 10/10) | **FIXED** T10 step 4 — the alternative is **removed**. Render prompts for `sync: false` only at *initial Blueprint creation*; an existing Blueprint ignores them, so the worker starts with empty vars and the fatal validator exits before anyone can suspend it. Dashboard creation with all eight values entered up front is now the only path; the resource is adopted into the Blueprint afterwards |
| m1 — resuming the worker does not pin the writer SHA (**introduced by my rev-7 resume edit**) (conf 8/10) | **FIXED** PLAN B §5.5 step 5 — the worker also has `autoDeploy: false`, so a resume can leave it on the old image; it still *works* (RPC defaults) but writes `p_research_verified=false` and no lookup keys, making every post-backfill row **invisible to T3** and silently depressing the hit-rate the Arc-2 GO/NO-GO rests on. Now: deploy the same SHA and assert it — a heartbeat proves liveness, not version |
| m2 — stale round metadata in PLAN A (conf 10/10) | **FIXED** — revision table completed through round 7, header rewritten, review report reconciled to seven rounds |

### Round-6 findings status

Round 6 scored **6.0** — a dip from 6.8 caused entirely by two self-inflicted release-sequence
defects, while **Correctness rose to 7.8** and **MAJOR was "None"**. Both blockers were introduced
by *my* round-5 fixes, which is the honest reading: a fix that changes a runbook can break the
runbook.

| Finding | Status in rev 7 |
|---|---|
| B1 — PLAN B suspends `astrail-backend` and **never resumes it** (conf 10/10) | **FIXED** PLAN B §5.5 step 4 — an explicit, non-optional resume: `/health` **and** `/readiness` (the deep probe; `/health` never touches the DB), one real DB-backed write, then resume the worker and confirm its heartbeat. Introduced by the round-5 m2 fix |
| B2 — the manual Blueprint path still creates the worker **before** its secrets exist (conf 9/10) | **FIXED** T10 Phase 1 step 4 — dashboard creation with all `sync: false` values entered up front (preferred), or sync-then-immediately-suspend-then-set-secrets; plus an explicit eight-variable gate before first start. Rev 6 named the hazard and then sequenced around it anyway |
| m1 — stale "`ValueError` dropped … return a tuple" contradicting `FilterResult` (conf 10/10) | **FIXED** T2 — replaced with explicit construction of all three fields |
| m2 — the 10-URL cap can still produce a false ✅ (conf 9/10) | **FIXED** T2/T4 — `FilterResult.truncated`; ✅ now requires all three of no rejected shapes, no truncation, all URLs durable |
| m3 — stale revision/review metadata in both plans (conf 10/10) | **FIXED** — PLAN B header rewritten (was still "rev 5 / PLAN A rev 4 / round 4 pending"), its round-3 table's superseded 9+1 count corrected to 7+7, PLAN A's terminal verdict updated, and a duplicated step number in PLAN B's runbook repaired |

### Round-5 findings status

Round 5: **no blockers.** Two majors, two minors — all folded.

| Finding | Status in rev 6 |
|---|---|
| M1 — Blueprint **Auto Sync** is a separate setting from `autoDeploy: false` and can sync on merge, before secrets exist | **FIXED** T10 Phase 1 step 0 — verify Auto Sync is disabled *before* merging, then manual sync with a preview gate and post-sync verification; fall back to creating the worker by hand |
| M1b — the stale "no `render.yaml` line in [the web] block" claim | **FIXED** — withdrawn explicitly; T9 does add `branch: dev`, and the accurate claim is that the web *runtime* is unchanged |
| M2 — the loud-drop contract still falsely acknowledges **mixed** messages, and T2's signature contradicted T4 | **FIXED** T2 returns `FilterResult{urls, rejected_shapes}`; T4 logs ERROR on **any** `rejected_shapes` regardless of valid URLs, and ✅ requires `rejected_shapes` empty **and** every URL durable; the mixed-message RED test is named explicitly |
| m1 — a swallowed reaction failure is indistinguishable from a rejection | **FIXED** T4 — WARN on reaction failure; the duplicate-job consequence quantified as a zero-charge cache hit |
| m2 — PLAN B's preflight checks emptiness without quiescing, and misses the worker | **FIXED** PLAN B §5.5 step 0 — suspend `astrail-backend` **and** `astrail-telegram-ingest` if PLAN A has shipped, *then* confirm empty |

### Round-4 findings status

| Finding | Status in rev 5 |
|---|---|
| B1 — the ingest account's limit is never raised (conf 10/10) | **FIXED** T10 Phase 2 step 7 — explicit owner-verified `UPDATE … returning`, assert exactly one row. Deleting `bootstrap_ingest_account.py` had removed the only place this appeared |
| B2 — Blueprint sync can retarget/redeploy `astrail-backend`; Phase 1 was not web-byte-identical (conf 10/10) | **FIXED** T9 — `branch: dev` pinned on the web block (a no-op against the running service), Blueprint preview must show the worker as the only change, post-sync verification required |
| M1 — "not silent" not implemented end-to-end (conf 9/10) | **FIXED** §3.1 + T4 — per-URL ERROR on every caught failure; unsupported-Instagram-URL ERROR instead of a silent `ValueError` swallow; **one ✅ per message, only when every URL became durable**; pinned-message human contract; four new RED conditions |
| m2 — "AS409 means accepted" not universally correct (conf 9/10) | **FIXED** T4 — special catch removed; an unexpected AS409 takes the normal per-URL ERROR path and gets no ✅ |
| m3 — Migration A is metadata-only but not lock-free (conf 9/10) | **FIXED** Risk 3 — "no rewrite, brief `ACCESS EXCLUSIVE`" + `lock_timeout = '3s'` |
| M2, M3, m1 | PLAN B — fixed in its rev 5 |
| F1 / F2 / F3 | **ALL VERIFIED TRUE by round 4.** No blocker derives from them |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 8 | **CLEAN** | 4.6 → 5.2 → 5.5 → 6.4 → 6.8 → 6.0 → 6.5 → **8.5 PASS**. R3: *"simplify as specified"* |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | **CLEAN** | 19 issues raised, scope reduced (S1); all folded by rev 9 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not applicable (backend only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** eight rounds, `gpt-5.6-sol` high-reasoning read-only.
4.6 → 5.2 → 5.5 → 6.4 → 6.8 → 6.0 → 6.5 → **8.5**. Rounds 1–3 failed by accreting machinery; round 3
named it (*"the added coordination machinery is now its largest deployment risk"*), rev 4 deleted it,
and round 4 verified the three deployed-SQL facts the deletion rests on. **Correctness then rose
every round (6.5 → 7.8 → 8.2 → 8.8) and MAJOR was "None" for three consecutive rounds.** The last
dimension to clear was Deployment safety, where every defect was a runbook-sequencing error
introduced by the previous round's own fix — fixed for good in rev 8 by rewriting both sequences
whole instead of patching them, which moved it 2.5 → 8.6.

**CROSS-MODEL:** Sustained agreement over eight rounds. Codex caught five factual errors the Claude
reviews had accepted as true: `reel_cache` is unique on `normalized_url` alone; `reel_place_mentions`
cascades on a cache-row delete; `_ground_place` verifies country, not venue identity; PLAN A's
cross-plan contract concealed a live-path change; and deleting `bootstrap_ingest_account.py` removed
the load-bearing quota `UPDATE`. Every one lived at the plan-vs-deployed-system boundary.

**VERDICT:** **CLEARED — READY TO IMPLEMENT.** Round 8 scored **8.5/10** against a bar of ≥7.0 with
no dimension ≤3; the lowest dimension is Clarity at 7.8. No blockers, no majors. Round 8: *"The two
deployment blockers and the worker-version defect are genuinely fixed. The remaining items are
documentation hygiene and exact-version proof, not reasons to reopen the architecture or delay
implementation."* Rev 9 folded those three hygiene minors and changed no design, sequencing, or scope.

**T0 CLOSED 2026-08-02 — PASS 3/3.** The share sheet emits canonical `/reel/<code>/`; no redirect
resolver, `reel_filter.py` stays pure, risk #1 retired. **Implementation starts at T1 (`api.py`).**

NO UNRESOLVED DECISIONS
