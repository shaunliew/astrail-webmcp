# The memory beat — prep, gates, and the one line to say

> Written 2026-09-01 after verifying the mem0 feature end to end (4 independent passes: 2 Claude
> agents, Codex cross-vendor, and a direct trace). Every claim below is cited to code.
>
> **Decision: memory does NOT get its own beat.** It rides inside the generation already being
> filmed at 1:05. No cut, no second generation, no restructuring of `VIDEO-FLOW.md`.

## Why it is not its own beat

The video is graded on *"what you built **and how you used WebMCP**."* Memory is the one major
Astrail feature that is **not** WebMCP — no registered tool reads or writes it (16 tools, checked
against `lib/webmcp/tools/index.ts`). It also pre-dates the submission window (mem0 commits run
2026-07-07 → 2026-08-02, before 25 Aug), so it cannot count as new WebMCP work.

Spending seconds from a zero-slack video on a pre-existing non-WebMCP feature trades against the
criterion that is hardest to win. The written Devpost description is where this story pays.

## The trap that makes prep mandatory

**Trip count is irrelevant.** Memory is written ONLY when the user typed preferences that trip:

```python
# pipeline/preferences.py:100-101
if ctx.source != "explicit" or not ctx.explicit_text:
    return None
```

And it is read ONLY when preferences are blank (`pipeline/preferences.py:114`). So the two paths
are exact opposites, and **neither does both**:

| Path | Writes? | Reads? | Why |
|---|---|---|---|
| **Agent** (`plan_trip_from_reels`) | ✗ | ✓ | leaves `preferences` blank → recall fires, nothing learned |
| **Manual PlanSheet** | ✓ | ✗ | `PlanSheet.tsx:85` prefills from the profile → counts as explicit |

Consequence: **running more agent trips will never populate memory.** If every prior test trip went
through the agent, mem0 is empty right now regardless of how many were run. The seeding trip must
be the manual UI with the preferences box filled in.

## Prep — off camera, before recording

1. **`MEM0_API_KEY` set on the backend you film against.** Declared in `render.webmcp.yaml` as of
   `86b5a1b`; the value is set in the Render dashboard. Absent = memory disabled
   (`mem0_client.py:63-65`), never a boot failure.
2. **Gate:** `curl <backend>/readiness` → expect `{"ready": true, "mem0": "configured"}`
   (`main.py:394`). `disabled` means no key. `init_failed` means the key is set but the client
   could not be built. Do not proceed on either.
3. **Seed it:** plan one trip through the normal UI (not the agent) with something typed into the
   preferences box — e.g. `walkable days, ramen, mid-range`. This is the write.
4. Wait ~10s. mem0's own ingestion is documented at 4-8s (`pipeline/preferences.py:41-42`).
5. **Gate:** open `/app/settings` → **"What Astrail remembers"** should now list the fact with a
   brass `Memory` tag (`SettingsView.tsx:122,148`). The read path always returns 200 by design, so
   an empty list here means the write did not land — not that the screen is broken.
   ⚠️ Do **not** click **Clear memory** on camera or off: `POST /settings/memory/clear` is
   deliberately gated off in the backend and will fail.

If step 5 shows nothing, **do not narrate memory.** Something upstream is wrong and you have found
it in 30 seconds instead of mid-take.

## On camera — no new prompt

The existing planning prompt is already correct, because it supplies no preferences:

```
Use the reels I just saved and plan me 2 days in Tokyo, 15 to 16 November
```

Blank preferences is exactly the condition that triggers recall. Nothing to change.

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
