# Demo run — the five beats, as prompts

> Run these in order against a signed-in trip. Every prompt is **bare** on purpose: an agent
> picking the right tool out of ordinary language is part of what is being demonstrated. If one
> gets browser control instead, ask it to use Astrail's own tools and repeat — that is a ChatGPT
> routing decision, not a fault in the page.
>
> **Each beat lists what PASS looks like.** Run this as verification, not as a vibe check: a beat
> that "seemed fine" is the one that fails on camera.

## Before you start

- Backend on :8001, frontend on :3000, both current.
- Signed in as the demo account, on a trip with **at least 4 stops across 2+ days** and at least
  one Reel-derived stop AND one Astrail-suggested stop (beat 4 needs both).
- Keep the **dock visible in frame** throughout — the tool count is the closing beat.

---

## Beat 1 · The problem (15s) — no prompt

On screen, quoted as real user feedback:

> *"It's unclear how to navigate the website — where to click, how to choose the reels, how to
> start generating a trip."*

No tool call. This is the claim the rest of the run pays off.

---

## Beat 2 · Orientation (25s)

```
What can I do here?
```

**PASS:** the agent calls `get_app_state` and answers in the app's own vocabulary — where you are,
what you have, what to do next, what is blocked. It does NOT read out a JSON envelope.

**FAIL, and what it means:**
- Reads `{"result":...}` aloud → the envelope is reaching the model unwrapped. **Stop and tell me**
  — that is the open QA item from round 9 and it is fixable.
- Answers from general knowledge without a tool call → routing; ask for Astrail's tools, repeat.

---

## Beat 3 · The edit loop (50s) — THE CENTREPIECE

```
Day 2 looks packed. Remove Nakamise-dori from it.
```
*(substitute a real stop name from your trip)*

**PASS — all five, in this order:**
1. An approval card appears **on the page**, not a question in chat
2. The card names the stop and says it cannot be undone
3. You approve → the stop goes and the map redraws
4. The rail shows the summaries rewriting themselves (REWRITE → REWROTE, ~30s)
5. The day summary afterwards does not mention the removed stop

**Then, while the rewrite is still running, ask for a second edit:**
```
Actually move stop 3 to day 3 as well.
```
**PASS:** a second card appears; the reply does NOT claim you declined anything; the rail credits
the right actor. Two quick edits must not leave a summary describing only the first.

---

## Beat 4 · Provenance (30s) — ask BOTH

```
Why is stop 1 on this trip?
```
**PASS:** a verbatim caption quote from the source Reel, plus a `reel:` link.

```
And why is stop 4 there?
```
*(pick an Astrail-suggested stop)*

**PASS:** it says Astrail suggested it and gives the reasoning — it does **not** dress a suggestion
up as a quote, and does not claim a missing Reel. **Showing the second case is what makes the
first believable.** This is the honesty beat; do not cut it for time.

---

## Beat 5 · Where it came from (25s) — time-compressed, labelled

Either cut to a pre-recorded generation, or state it over the finished trip:

> Reels in, routed itinerary out. Measured at 123.5 seconds — restaurants are 94% of it.

**Say the real number.** A judge who suspects a hidden wait trusts nothing else in the video.

---

## Closing · Scoped tools (15s) — show, do not say

Open the dock on `/app/trip/demo` **signed out**: six tools. Then the signed-in trip: sixteen.

> The app's capabilities grow as its state changes.

That is WebMCP used as designed rather than as an RPC shim, and it is the one Leverage point that
lands without a word of explanation.

---

## Do NOT demo

| | Why |
|---|---|
| Hotels / hub view | `HOTEL_SEARCH_ENABLED = False`; `set_map_mode hub` declines on any trip made since 30 Aug |
| 3D buildings | No tool sets 3D — `set_map_mode` is `route`\|`hub`, and buildings are `minzoom: 15` while the deepest tool camera is 14 |
| Undo | There is none, deliberately — Astrail has no inverse to offer |
| A live generation in full | 123.5s of a 180s budget |

## Also worth running once, off-camera

Move the trip's dates a month out. The card should warn that the forecast will be cleared, the day
panels should then show **no weather line at all** (not a blank slot), and the reply should name
how many days lost theirs. Then extend only the END date — every existing day must KEEP its
forecast. That path was broken until this morning.
