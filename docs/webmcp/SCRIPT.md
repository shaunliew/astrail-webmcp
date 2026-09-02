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

| | Beat | Runs | Words | Why it is here |
|---|---|---|---|---|
| 0:00–0:16 | **"Why is stop 3 here?"** | 16s | ≤26 | The strongest opening we have: agent, live map, evidence, in one action |
| 0:16–0:28 | `What can I do here?` | 12s | ≤20 | It reads the page it is signed into |
| 0:28–1:08 | **Plan it. It asks how you travel.** | 40s | ≤52 | The centrepiece: two tools cooperating, and consent |
| 1:08–1:28 | `Add Tokyo Disneyland to day 2` | 20s | ≤30 | The itinerary is not a static output |
| 1:28–1:50 | **It remembered** | 22s | ≤30 | The differentiator, without a second generation |
| 1:50–2:38 | **How it is built** | 48s | ≤100 | The requirement: how we used WebMCP |
| 2:38–2:45 | Close | 7s | 0 | URL and repo on screen |

---

## 0:00 — Cold open · "Why is stop 3 here?"

**No title card. No logo. Open on a finished trip, already signed in, agent panel visible.**

Paste:

```
Why is stop 3 on this trip?
```

The map flies to the stop and its evidence opens: the **verbatim caption quote** from the Reel
the place was found in, and a link back to that Reel.

> Say: "That is an agent driving the page I am looking at. Every stop on this map says where it
> came from, and this one is a quote from the reel it was found in."

On-screen text: **17 WebMCP tools · no invented places**

**Why this and not the reels beat.** Saving links into a library looks like ordinary browser
automation. This shows the agent moving a real map and producing provenance in one action, which
is the thing only an in-page tool can do.

## 0:16 — It reads the page

```
What can I do here?
```

> Say: "It can read the page I am signed into. It knows what I have, and what I can do next."

Cut the moment the useful sentence lands.

## 0:28 — The centrepiece · plan it, and it asks

Paste:

```
Save these reels: <url1> <url2> <url3> <url4>
```

Let the library fill, then paste:

```
Use the reels I just saved and plan me 2 days in Tokyo, 15 to 16 November 2026
```

**Two tools cooperate on one ordinary sentence.** The agent calls `list_saved_reels`, reads the
URLs out of the library itself, and hands them to `plan_trip_from_reels`. You never typed a URL.

**Then it stops and asks how you like to travel**, because Astrail has nothing remembered for this
account and will not spend the trip allowance on a generic first draft. Nothing has been charged
at this point and no approval card has appeared yet.

Answer out loud:

```
walkable days, good ramen, not too rushed
```

The approval card renders that back to you word for word. Approve.

> Say: "It reads my library itself, so I never hand it a link. Then it asks how I travel, because
> it has nothing saved for me yet, and it asks on the page rather than in chat."

**Then CUT.** On-screen text over the cut: **generation takes about two minutes · cut for time**

Come back on the finished trip.

## 1:08 — Change it by saying so

```
Add Tokyo Disneyland to day 2
```

> Say: "The trip is not a static output. Astrail geocodes the place itself, asks me on the page,
> and the route redraws. The day summaries rewrite themselves to match."

Approve, let the map redraw, cut once the summaries update. Speed this up 1.5x if it drags.

## 1:28 — It remembered

**New ChatGPT conversation**, so nothing carries over from the last one.

⚠️ Save two Osaka reels into the library BEFORE this take. Asking it to plan Osaka "from my saved
reels" when the library holds only Tokyo reels is an incoherent request on camera.

Paste, then **cut straight to the populated card** — do not play the tool calls again:

```
Use my saved reels and plan me 2 days in Osaka, 20 to 21 December 2026
```

The card names what Astrail remembers, and offers a field to say otherwise:

```
Astrail remembers: walkable days · good ramen · not too rushed
[ different this trip? (optional) ______________ ]
[ Try what it remembers ]   [ Not now ]
```

> Say: "New trip, new city, and I said nothing about how I travel. It remembered from the last
> one, and it still asks."

**Cut here.** The card is the payoff. Do not run a second generation.

On-screen text: **remembered from trip 1 · still asks**

## 1:50 — How it is built · ~100 words, 48s

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

On-screen text through this section, so the narration does not have to carry the numbers:
**17 tools · 14 global · 3 trip-scoped · 6 with no account**
**execute() runs in the page · edits stop for approval**

## 2:38 — Close

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

**Clear mem0.** Both memory beats depend on it: the agent asks at 0:28 only when memory is
definitely empty, and the 1:28 card has nothing to name unless trip 1 wrote something first.
There is no in-app reset — use mem0's dashboard, then confirm `/app/settings` reads "Astrail
hasn't remembered anything yet".

**Save two Osaka reels** after trip 1 and before the 1:28 take.

This is the one prerequisite that cannot be recovered mid-take.

## Cut order, if the edit runs long

Pre-agreed, so it is not a panic decision at 3:05.

1. The 0:16 "what can I do here" beat. It shows introspection but little visible product value.
2. Trim the architecture narration further and push more onto on-screen text.
3. Shorten the close to two seconds.
4. Cut the add-place beat to approval, hard cut, changed map.

**Never cut:** the completed plan, the live map mutation, the evidence popup, or the memory card.
Those four are the product.

## What we deliberately cut

| | Why |
|---|---|
| The 22-second hook and tagline | "Show it working in the first 10 to 15 seconds" and "save your story for the description" |
| The Instagram B-roll | Setup, not product |
| The compressed generation | "Cut all load times." A jump cut and one line of text does it |
| A second generation | "One strong example." The card is the memory payoff |
| 3D buildings | No tool sets it, and the seconds are worth more elsewhere |
| Hotels, hub view | Search is off; hub declines everywhere |
