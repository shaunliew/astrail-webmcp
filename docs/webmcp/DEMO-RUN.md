# Demo run — the main narrative

> **Decided 2026-08-31: the TWO-STEP flow is the narrative.** Save the reels, then plan from them
> — not one prompt that does both. The reasoning is in "Why two steps" at the bottom; it is a
> rubric decision, not a preference, and it should not be quietly reversed to save 30 seconds.
>
> Run on a **signed-in account with zero reels and zero trips**. An empty account is what a judge
> sees, and it is the only state where the orientation beat is honest rather than staged.
>
> Every prompt is **bare** on purpose: an agent picking the right tool out of ordinary language is
> part of what is being demonstrated. If one gets browser control instead, ask it to use Astrail's
> own tools and repeat — that is ChatGPT's routing decision, not a fault in the page.

## Before you start

```bash
# What will this cost? Read-only. Uncached reels = real Apify calls + real quota slots.
cd backend && uv run python -m scripts.check_reel_cache "<url1>" "<url2>" "<url3>"

# Both servers alive and current
curl -s http://localhost:8001/health && curl -s http://localhost:8001/readiness
curl -s -o /dev/null -w "frontend HTTP %{http_code}\n" http://localhost:3000/
```

Keep `tmux attach -t astrailapi` visible in a second window. **Silence in that log means ChatGPT
drove the DOM instead of calling a tool** — identical on screen, obvious in the log.

Pick **2–3 reels from the same city**. The pipeline dedups across reels and builds one route, so
reels from different countries produce a scattered trip that demos badly. Public accounts only.

---

## The eight beats · 3:00

| | Beat | Runs |
|---|---|---|
| 0:00–0:15 | The problem, in the user's own words | 15s |
| 0:15–0:30 | Orientation on a genuinely empty account | 15s |
| 0:30–0:50 | **Save the reels — the page fills while the agent talks** | 20s |
| 0:50–1:10 | Plan the trip — the approval card, before any spend | 20s |
| 1:10–1:25 | Generation, time-compressed and labelled | 15s |
| 1:25–2:00 | Provenance — asked twice, deliberately | 35s |
| 2:00–2:40 | **The edit loop** | 40s |
| 2:40–3:00 | Scoped tools, shown not said | 20s |

---

### 1 · The problem — no prompt

On screen, quoted because it is real user feedback:

> *"It's unclear how to navigate the website — where to click, how to choose the reels, how to
> start generating a trip."*

Everything after this is the answer to that sentence.

### 2 · Orientation

```
What can I do here?
```

**PASS:** names that you have **no reels and no trips**, and points at saving reels as the next
step. **This only works on an empty account** — on a full one it is a feature demo, not a fix.

**FAIL:** reads `{"result":...}` aloud → the envelope is reaching the model unwrapped. Stop and
report it; it is a known open item and no unit test can catch it.

### 3 · Save the reels — the money shot

```
Save these reels: <url1> <url2> <url3>
```

**PASS:** the page moves to the library and the reels appear **while the agent is still speaking**.
`save_reels` awaits its reveal, so the tool cannot report a save the screen has not caught up with.
That is the whole claim — the agent acted, the page changed — shown rather than asserted.

⚠️ **Narrate consent accurately here.** `save_reels` spends with **no approval card**, deliberately.
The *planning* asks; the *saving* does not.

### 4 · Plan the trip

```
Plan me 2 days in Tokyo, 15 to 16 November
```

**PASS:** an approval card on the page with your request shown before anything is spent. Approve.
Returns in about a second with a trip id — the trip is NOT ready yet.

### 5 · Generation

```
How's it going?
```

**PASS:** live stage narration — elapsed seconds, stage N of M, the last decision made. Ask twice;
it self-throttles rather than spinning. **Say the real number on camera** (~120s, restaurants are
most of it). A judge who suspects a hidden wait trusts nothing else in the video.

### 6 · Provenance — ask BOTH

```
Why is stop 1 on this trip?
```
**PASS:** a verbatim caption quote from the source Reel, plus a `reel:` link.

```
And why is stop 3 there?
```
*(pick a stop labelled "Astrail pick" or "You asked")*

**PASS:** it says it was suggested or requested and gives the reasoning — it does **not** dress a
suggestion up as a quote. **Showing the second case is what makes the first believable.** A judge
who only sees the quote has no way to know the system would not have invented one. Do not cut this
for time.

### 7 · The edit loop

```
Day 2 looks packed. Remove <stop name> from it.
```

**PASS, in order:** approval card **on the page**, not a question in chat → approve → the stop goes
and the map redraws → the rail shows `REWRITE → REWROTE` → the day summary afterwards does not
mention the removed stop.

Then, **while that rewrite is still running**:

```
Also move stop 2 to day 1.
```

**PASS:** a second card appears; the reply does **not** claim you declined anything; both edits end
up reflected in the summaries, not just the first.

### 8 · Closing — scoped tools

Open `/app/trip/demo` in a **signed-out** window. The dock reads **six tools**; your signed-in trip
reads seventeen.

> The app's capabilities grow as its state changes.

WebMCP used as designed rather than as an RPC shim — the one Leverage point that lands without a
word of narration.

---

## One line worth adding, not a beat

After the trip lands:

> "You don't have to save them first — paste the links straight into the request and it handles
> both."

True (`plan_trip_from_reels` accepts raw URLs and adds them to the library), costs three seconds,
and earns something the two-step flow cannot: the agent adapts to how you happen to talk. Same
argument as keeping the prompts bare.

---

## Why two steps — do not reverse this without reading it

`plan_trip_from_reels` accepts raw links, so one prompt works. It is still the weaker narrative:

- **WebMCP Leverage.** One prompt exercises exactly one tool and then you watch a progress bar for
  two minutes. Two steps show two tools, and `save_reels` **visibly moves the page** (it awaits
  `deps.reveal()`). The agent acted and the page changed — demonstrated, not claimed.
- **Impact.** The measured complaint is *"how to choose the reels, how to start generating a trip"*.
  The two-step flow shows exactly that step being done for the user. **One prompt skips the step
  the user complained about.**
- **Execution.** The library filling is the app's own state responding. Prompt → wait → trip is a
  black box a judge cannot distinguish from a slow API call.

The extra cost is one prompt and ~30s of extraction — and generation is time-compressed anyway, so
the real question is what to **show**, not what to wait for. Thirty seconds of the page filling
beats thirty more seconds of a progress bar.

---

## Do NOT demo

| | Why |
|---|---|
| Hotels / hub view | `HOTEL_SEARCH_ENABLED = False`; hub declines on every trip, demo included |
| 3D buildings | No tool sets 3D — `set_map_mode` is `route`\|`hub`, buildings are `minzoom: 15`, deepest tool camera is 14 |
| Undo | There is none, deliberately — Astrail has no inverse to offer |
| A live generation in full | ~120s of a 180s budget |
| Approval cards on `/app/trip/demo` | Signed-out gets only the six read tools, so no card can appear there |

## Worth running once, off camera

```
Change the trip dates to Nov 22 to Nov 23
```
Card warns the forecast will be cleared; weather rows then vanish entirely rather than showing
blank. Then extend only the END date — every existing day must KEEP its forecast.

```
Add Tokyo Tower to day 1
```
It should look the place up itself, **not** ask you for coordinates.
