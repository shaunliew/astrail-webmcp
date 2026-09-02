# The submission video — script

> Written 2026-09-02 against Devpost's "2 days left" guidance, then rewritten after a cross-model
> review found it would run 3:15–3:30 and carried four claims the code does not support.
> Supersedes `VIDEO-FLOW.md` and `NARRATION.md`, which stay as the record of what we cut and why.
>
> **Hard requirements:** under 3:00 · public on YouTube · audio · covers what you built AND how
> you used WebMCP.

## The two things that decide this

**Timing is a hard fail.** The first draft budgeted 2:55 and would have run past 3:00, mostly
because its architecture section was 170 words in a 50-second slot — 204 words per minute, where
a clear technical pace is 120–140. Every beat below now has a **word budget**, not just a time
budget. Stay under them and the video lands at **2:45** with real margin.

**Every claim gets filmed.** A judge can pause. Four sentences in the first draft were false and
are corrected below, each with a note saying what the true version is, because the tempting
phrasing is the wrong one in all four cases.

---

## The shape · 2:45

The opening carries all three of the things this project is, in one motion: **Instagram Reels**,
**travel planning**, and an **agent driving the page through WebMCP tools**. A judge who watches
only the first twenty seconds should be able to say what Astrail does and how it is being
operated.

| | Beat | Runs | Words | Why it is here |
|---|---|---|---|---|
| 0:00–0:22 | **Reels to a routed trip, by asking** | 22s | ≤40 | The product, the premise and the tools in one action |
| 0:22–0:38 | **"Why is stop 3 here?"** | 16s | ≤26 | Evidence: the caption quote behind a pin |
| 0:38–0:58 | `Add Tokyo Disneyland to day 2` | 20s | ≤30 | The itinerary is not a static output |
| 0:58–1:20 | **It remembered** | 22s | ≤30 | The differentiator, without a second generation |
| 1:20–1:34 | `What can I do here?` | 14s | ≤20 | It reads the page it is signed into |
| 1:34–2:22 | **How it is built** | 48s | ≤100 | The requirement: how we used WebMCP |
| 2:22–2:30 | Close | 8s | 0 | URL and repo on screen |

---

## 0:00 — The hook · Reels to a routed trip

**No title card. No logo. Already signed in, four Instagram Reels already saved, agent panel
visible. Start on the library so the Reels are on screen from frame one.**

Paste, do not type:

```
Use the reels I saved and plan me 2 days in Tokyo, 15 to 16 November 2026
```

By 0:15 a viewer has seen the Reels, the tool calls firing, and Astrail asking a question back.
That is the whole product and the whole mechanism, before anything is explained.

**The agent reads the library itself.** It calls `list_saved_reels`, takes the URLs out of your
saved Reels, and hands them to `plan_trip_from_reels`. You never gave it a link.

⚠️ Run this in a conversation where you have NOT pasted the URLs. If they are in the chat history
the agent can hand them straight over without reading the library, and the claim above stops being
true. Save the Reels in the app, or in an earlier conversation.

**Then it asks how you like to travel**, because Astrail has nothing remembered for this account
and will not spend the trip allowance on a generic first draft. Nothing has been charged and no
approval card has appeared yet.

Answer out loud:

```
walkable days, good ramen, not too rushed
```

The approval card renders that back, the words the AGENT passed, which may be a paraphrase of what
you said. If it is not your phrasing, decline and rephrase; nothing has been spent. Approve.

> Say: "Instagram reels I saved, into a real trip. An agent is doing this, reading my library
> itself, and asking how I travel before it spends anything."

On-screen text: **Instagram Reels to a routed trip · 17 WebMCP tools · nothing spent yet**

**Then CUT.** On-screen over the cut: **generation takes about two minutes · cut for time**

Come back on the finished trip: map, numbered pins, route.

## 0:22 — Why is stop 3 here?

Click or ask. Pasting keeps it on the tools:

```
Why is stop 3 on this trip?
```

The map flies to the stop and its evidence opens: the **verbatim caption quote** from the Reel the
place was found in, and a link back to that Reel.

> Say: "Every stop says where it came from. This one is a quote from the caption of the reel it
> was found in. Astrail's own suggestions say so, and so do the ones I asked for."

On-screen text: **no invented places**

## 0:38 — Change it by saying so

```
Add Tokyo Disneyland to day 2
```

> Say: "The trip is not a static output. It asks me on the page first, then finds the place itself
> and redraws the route. The day summaries rewrite themselves to match."

⚠️ Order matters and the card says so: it appears BEFORE the lookup and reads "It will be looked
up as…", future tense. Do not narrate the geocode as already done.

Approve, let the map redraw, cut once the summaries update. Speed up 1.5x if it drags.

## 0:58 — It remembered

**New ChatGPT conversation**, so nothing carries over.

⚠️ Save two Osaka Reels into the library BEFORE this take. Asking it to plan Osaka "from my saved
reels" when the library holds only Tokyo Reels is an incoherent request on camera.

Paste, then **cut straight to the populated card**. Do not play the tool calls again:

```
Use my saved reels and plan me 2 days in Osaka, 20 to 21 December 2026
```

The card names what Astrail remembers and offers a field to say otherwise:

```
Plan a trip from 2 reels
Dates: 2026-12-20 to 2026-12-21
No preferences given — Astrail will try to recall what it remembers
about how you travel: <what mem0 actually stored>
This uses your trip allowance.

Different this trip? (optional)  [ ______________________ ]

[ Try what it remembers ]   [ Not now ]
```

⚠️ **Do not read that middle line off this page.** The facts come back as mem0's OWN prose, not
your words: the backend stores `Travel preferences: <what you said>` and lets mem0 infer, so it
may come back rephrased. On the account we tested it returned "User prefers travel days that are
walkable, feature good ramen, and are not too rushed." **Screenshot the real card in rehearsal and
narrate what it actually says.**

"Astrail remembers: …" is the HOME SCREEN line, not the card. Two different surfaces.

> Say: "New trip, new city, and I said nothing about how I travel. It remembered from the first
> one, and it still asks."

**Cut here.** The card is the payoff. Do not run a second generation.

On-screen text: **remembered from trip 1 · still asks**

## 1:20 — It reads the page it is on

```
What can I do here?
```

> Say: "And it can read the page I am signed into. It knows what I have, and what I can do next."

Cut the moment the useful sentence lands. **This is the first beat to drop if the edit runs long.**

## 1:34 — How it is built · 87 words, 48s

Read this over whatever visual you make. Every number is verified, and the counts are on screen so
the narration does not have to carry them.

> Astrail registers seventeen tools with `document.modelContext.registerTool`, and what matters is
> where they run. `execute` runs inside the page.
>
> When the agent moved the map a moment ago, it called the same setters the page's own controls
> call, on the same React state. Not an API it hoped would work.
>
> Writes go to FastAPI, owner-checked, and every edit to your trip stops for an approval card on
> the page, not a question in chat.
>
> And the agent can now read what Astrail remembers, and offer it while planning.

On-screen text through this section:
**17 tools · 14 global · 3 trip-scoped · 6 with no account**
**execute() runs in the page · edits stop for approval**

⚠️ Read at 120 to 140 words per minute. If it feels rushed you are over budget, and over 3:00 is
a hard fail.

## 2:22 — Close

On screen, no narration:

```
astrail-webmcp.vercel.app
github.com/shaunliew/astrail-webmcp
```

---

## The four claims that were false, and their corrections

A cross-model review caught all four. Each tempting phrasing is the wrong one.

| Do NOT say | Why it is false | Say instead |
|---|---|---|
| "Every write asks" | `save_reels` spends with no card, deliberately, and the map tools change the page without one | "Every edit to your trip stops for an approval card" |
| "Reads never leave the browser" | `get_remembered_preferences` is an authenticated backend read; `list_trips` and `get_itinerary` fetch too | "Map actions and the open trip use state already in the page" |
| Adding a stop is "the same event as you doing it" | There is no manual add-stop UI. `add_place` calls a FastAPI endpoint, then refetches | Use **`show_on_map`** for that claim. Map tools genuinely receive the page's own `showDay`, `selectPlace` and `setLayerMode` (`TripTools.tsx:72`) |
| "What I just said gets remembered" | Write-back is best-effort and tolerates five documented failure modes | "It tries to remember it." On the filmed run the later card proves it did |

One more, softer: "the memory is the one thing an agent could never reach" is too broad. The
planning tool always accepted a preferences argument; what was missing was any reason for an
agent to fill it, and any way to read back what was stored.

## Impact — say this once, on screen

The rubric scores **Potential Impact** equally with the rest, and the script demonstrates
mechanics without ever naming who this is for. One line of on-screen text at 0:00 fixes it
without spending narration:

**For travellers whose trip ideas are stuck in saved Reels**

## Recording notes

- **Record in short clips**, one per beat. A bad take costs one beat, not the video.
- **Paste every prompt.** Typing is dead air and the guidance calls it out by name.
- **Jump cut every pause**, especially between a prompt landing and the first token.
- **Do not film the login.** The video is public on YouTube permanently.
- **Keep the agent panel in frame.** It is the visible evidence that tools are being called.
- Read the architecture beat at 120–140 WPM. If it feels rushed, it is over budget.

## Before take one

**Clear mem0, and check it is REACHABLE.** Both memory beats depend on it: the agent asks at 0:28
only when memory is definitely empty, and the 1:28 card has nothing to name unless trip 1 wrote
something first. There is no in-app reset — use mem0's dashboard, then confirm `/app/settings`
reads "Astrail hasn't remembered anything yet".

Empty is not enough. A mem0 timeout or outage reads as UNKNOWN, not as empty, and unknown
deliberately proceeds — so the agent silently skips the question and plans anyway. That is
correct behaviour (memory must never block a trip) and it is indistinguishable on camera from
the feature not existing. `curl <backend>/readiness` must say `"mem0":"configured"` before you
roll.

**Verify trip 1 actually wrote something** before filming trip 2. Write-back is best-effort past
five swallowed failure modes, so check `/app/settings` lists the fact rather than assuming.

**Save two Osaka reels** after trip 1 and before the 1:28 take.

This is the one prerequisite that cannot be recovered mid-take.

## Cut order, if the edit runs long

Pre-agreed, so it is not a panic decision at 3:05.

1. **The 1:20 "what can I do here" beat.** It shows introspection but little visible product
   value, and it is deliberately placed last among the demo beats so it can go cleanly.
2. Trim the architecture narration and push more onto on-screen text.
3. Shorten the close to two seconds.
4. Cut the add-place beat to approval, hard cut, changed map.

**Never cut:** the hook, the evidence popup, or the memory card. Those three are the submission.

## What we deliberately cut

| | Why |
|---|---|
| The 22-second hook and tagline | "Show it working in the first 10 to 15 seconds" and "save your story for the description" |
| The Instagram B-roll | Setup, not product |
| The compressed generation | "Cut all load times." A jump cut and one line of text does it |
| A second generation | "One strong example." The card is the memory payoff |
| 3D buildings | No tool sets it, and the seconds are worth more elsewhere |
| Hotels, hub view | Search is off; hub declines everywhere |
