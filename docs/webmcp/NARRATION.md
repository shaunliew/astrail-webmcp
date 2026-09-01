# Narration script

> The words to say. Timings and what to show are in `VIDEO-FLOW.md`; the prompts to type are in
> `DEMO-PROMPTS.md`.

## 0:00 — The hook · ~22s

> Everyone has a trip they mean to take. The inspiration is already there — saved reels, a
> collection you keep adding to. And then nothing happens, because going from idea to execution is
> tedious: you research the same places again across a dozen sources and plan the whole thing by
> hand. So the reels just sit there.
>
> **Astrail is a WebMCP-powered, AI-native trip planner that makes your inspiration executable.**

## 0:32 — Orientation

> The account is empty — no reels, no trips. So I just ask it what I can do.

*(let the answer play; it reads the live page and says what is there and what is next)*

## 0:47 — Saving

> I paste the three reels I saved. Astrail takes them and starts pulling the places out —
> and the library fills up while it's still talking.

⚠️ If you say anything about consent here, be accurate: **saving spends without an approval card.**
The planning asks; the saving does not.

## 1:05 — Planning · the main beat

> Now I ask it to use the reels I just saved. It reads them out of my library itself — I never
> hand it a link. It asks before it spends anything, and then the pipeline runs: scraping,
> extracting places, de-duplicating them, routing, and writing the days.
>
> About two minutes end to end. Most of that is restaurant research.

*(compress the wait on screen and label it)*

## 1:35 — Editing

> The trip isn't a static output. I ask for a stop to be added, Astrail asks me on the page —
> not in chat — and when I approve it, the map redraws and the day summaries rewrite themselves
> to match the trip I now have.

## 2:05 — 3D

> And I can just look around it.

⚠️ Do not ask the agent for 3D and do not imply it did this — no tool sets it. You are zooming.

## 2:20 — How it's built · ~40s

> Astrail registers sixteen tools with `document.modelContext.registerTool` — thirteen across the
> app, three more the moment a trip is open. Six of them work with no account at all.
>
> The part that matters is *where they run*. `execute` runs inside the page, not on a server. So a
> tool already has the trip you're looking at, your session, and the same state setters a click
> uses. When the agent moves a stop, it isn't calling an API and hoping — it's the same event as
> you dragging it. Same map, same code path.
>
> Reads never leave the browser. Writes go to FastAPI, owner-checked — and anything that changes
> your trip stops for an approval card on the page, not a question in chat.

### The 25-second cut, if you run long

> Astrail registers sixteen tools with `document.modelContext.registerTool` — thirteen across the
> app, three more once a trip is open. The part that matters is where they run: `execute` runs
> inside the page, not on a server, so a tool already holds the trip you're looking at and the same
> state setters a click uses. Reads never leave the browser. Anything that changes your trip stops
> for an approval card on the page.

---

## Numbers — verified, do not round

| | |
|---|---|
| Tools | **16** = 13 global + 3 map (`lib/webmcp/tools/index.ts`) |
| Signed out on `/app/trip/demo` | **6** |
| Generation | **~123.5s** measured, restaurants ~94% of it |

A judge can count the tools in the address bar while you talk. A wrong number there costs more
than a vague one would have.
