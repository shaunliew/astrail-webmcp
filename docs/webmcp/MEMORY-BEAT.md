# The memory beat — prep, gates, and the one line to say

> Written 2026-09-01 after verifying the mem0 feature end to end (4 independent passes: 2 Claude
> agents, Codex cross-vendor, and a direct trace). Every claim below is cited to code.
>
> **Decision: memory does NOT get its own beat.** It rides inside the generation already being
> filmed at 1:05. No cut, no second generation, no restructuring of `VIDEO-FLOW.md`.

## Why it is not its own beat

The video is graded on *"what you built **and how you used WebMCP**."* The mem0 engine itself
pre-dates the submission window (commits run 2026-07-07 → 2026-08-02, before 25 Aug), so **the
memory feature cannot be claimed as new work** — only the WebMCP layer over it can.

That layer now exists: `get_remembered_preferences` lets the agent say what Astrail remembers, and
`plan_trip_from_reels` asks the user how they travel when nothing is stored yet. Both were built
after 26 Aug and are listed as challenge work. What must NOT be claimed is that Astrail's memory
was built for this hackathon; what CAN be claimed is that agents reached it for the first time.

Spending seconds from a zero-slack video on a pre-existing non-WebMCP feature trades against the
criterion that is hardest to win. The written Devpost description is where this story pays.

## How the loop actually closes

Memory is written ONLY when preferences were stated for that trip, and read ONLY when they were
left blank:

```python
# pipeline/preferences.py:100-101
if ctx.source != "explicit" or not ctx.explicit_text:
    return None
```

That used to make the agent path a dead end in both directions — it left `preferences` blank, so
it could recall but never learn, and an account planned entirely through the agent stayed empty
forever. Two changes closed it (both after 26 Aug, both listed in `WHATS-NEW.md`):

1. **`plan_trip_from_reels` asks first.** When the user states nothing AND nothing is remembered,
   the tool returns without starting — nothing spent, no card shown — and tells the agent to ask
   how they like to travel. The answer comes back as `preferences`, which makes the run explicit,
   which is what writes the memory.
2. **`get_remembered_preferences`** lets the agent read the stored memories back.

**Only a definite empty asks.** A failed or disabled memory read is *unknown*, and unknown
proceeds — interrogating someone who already has preferences saved, because a read failed, is the
worse failure (guardrail #3).

So the seeding trip no longer has to go through the manual form. The agent asks, you answer, and
trip 1 both plans and teaches.

## The one-conversation trap

**Trip 2 must be a NEW ChatGPT conversation.** Any non-blank `preferences` deterministically
suppresses recall (`preferences.py:114`), and a model that just heard you say "walkable days,
ramen" for trip 1 has every reason to resend it for trip 2. Then the run is `explicit`, recall
never fires, and the payoff silently fails on camera.

The param description tells it not to carry preferences over, but that is a nudge, not
enforcement — there is no server-side way to tell "the model repeated old context" from "the user
said it again". A fresh conversation removes the incentive entirely and costs nothing.

## Prep — before recording

1. **`MEM0_API_KEY` set** on the backend you film against. Declared in `render.webmcp.yaml`;
   value set in the dashboard. Absent = memory disabled (`mem0_client.py:63-65`).
2. **Gate:** `curl <backend>/readiness` → `{"ready": true, "mem0": "configured"}` (`main.py:394`).
   `disabled` means no key; `init_failed` means the key is set but the client would not build.
3. Decide whether trip 1 is on camera or prep. Either way it must **state a preference** — which
   now happens naturally, because the agent asks for one on an empty account.
4. Wait ~10s after trip 1 completes. mem0's ingestion runs 4-8s behind
   (`pipeline/preferences.py:41-42`), and the write is awaited after the terminal result event.
5. **Gate:** ask the agent *"what do you remember about how I travel?"* — `get_remembered_
   preferences` should read the fact back. Or open `/app/settings`. Either proves the write landed.
   ⚠️ Do not click **Clear memory**: `POST /settings/memory/clear` is deliberately gated off.

If step 5 comes back empty, **do not narrate memory.** Found in seconds instead of mid-take.

## On camera — the two-trip shape

**Trip 1** — the existing prompt, unchanged:

```
Use the reels I just saved and plan me 2 days in Tokyo, 15 to 16 November
```

On an empty account the agent now comes back asking how you like to travel. Answer it out loud —
that answer is what gets remembered. The approval card then echoes `Preferences: "..."` verbatim,
so you can **see the capture before anything is spent**. If the card does not show it, decline and
rephrase; nothing is lost.

**Trip 2** — in a **new conversation**, state no preference:

```
Plan me 3 days in Osaka, 20 to 22 November, from my saved reels
```

The first stage row should read *"Using your saved travel preferences: …"*. That is the payoff.
You can cut the take there — the rest of the generation is not needed for this beat.

## Read the screen before you say the line

During the generation, the `preferences` row appears **first** of twelve stages and stays on
screen — `GenerationProgress` renders an accumulating list (`GenerationProgress.tsx:186`), it does
not overwrite. Three possible messages (`pipeline/preferences.py:60-70`):

| On screen | Means | Say the line? |
|---|---|---|
| **"Using your saved travel preferences: …"** | mem0 supplied it | ✅ **yes** |
| "Using your preferences: …" | you typed it this trip | ❌ no |
| "No preferences provided — Astrail will infer a balanced first draft from your Reels." | mem0 returned nothing | ❌ **no** |

Since `86b5a1b` the brass **`Memory`** chip renders on the first row only. It used to render on all
three, which is how this branch got misread as working when it was not.

**The line, if and only if the first row appears:**

> And it already knows how I travel — I never told it that this time. It remembered from a trip I
> planned before.

That is ~5 seconds inside a beat already budgeted at 30. Nothing gets cut.

## Do not use these as proof

- **`/app/trip/demo`** contains a memory line (`fixtures/tokyo-trip.ts:292`, `:48`) but it is
  **fixture text**. Deterministic and safe to have on screen; presenting it as evidence of live
  recall would be overstating a capability, which the rules penalise.
- **`preference-disclosure.ts`** never renders in production — `TripBriefReview.tsx:70` returns
  early unless `MOCK_AUTH_ENABLED`, and it reads the mock API. Dead surface.
- **`lib/profile/memory.ts`** has zero production consumers; no place card ever shows a Memory
  evidence chip.

## The honest limitation, if asked

Remembered preferences are **soft guidance** injected into two prompts — the restaurant agent
(`genagents/restaurant.py:118-132`) and the narrator (`genagents/narrator.py:51-60`). They never
touch the deterministic dedup/assemble path. So memory changes which restaurants surface and how
the days read; it does not restructure the route. Say that if a judge asks — it is a better answer
than implying more.
