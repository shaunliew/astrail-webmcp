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

## The shape · 2:35

Shaun's actual demo flow, in the order he runs it. The evidence beat is cut: provenance is a real
differentiator but it costs 16 seconds, and the memory arc needs two trips.

| | Beat | Runs | Words | Why it is here |
|---|---|---|---|---|
| 0:00–0:10 | `What can I do here?` | 10s | ≤18 | An agent reading the page, on an empty account |
| 0:10–0:20 | **Save four Reels** | 10s | ≤16 | The premise: Instagram Reels are the input |
| 0:20–0:52 | **Plan it. It asks how you travel.** | 32s | ≤48 | The centrepiece, and the trip that teaches memory |
| 0:52–1:10 | `Add Tokyo Disneyland to day 2` | 18s | ≤28 | The itinerary is not a static output |
| 1:10–1:20 | **Save two Osaka Reels**, new conversation | 10s | ≤12 | Sets up the payoff |
| 1:20–1:40 | **It remembered** | 20s | ≤28 | The differentiator, without a second generation |
| 1:40–2:28 | **How it is built** | 48s | ≤100 | The requirement: how we used WebMCP |
| 2:28–2:35 | Close | 7s | 0 | URL and repo on screen |

**The first 15 seconds** cover an agent answering from the live page and Instagram Reels landing
in the library. By 0:25 the plan is running. That satisfies "show it working in the first 10 to
15 seconds" without a title card or a hook paragraph.

---

## 0:00 — What can I do here?

**No title card. Already signed in. Empty account: no Reels, no trips.**

```
What can I do here?
```

> Say: "An empty account, and I just ask. It reads the page I am signed into and tells me what I
> have and what comes next."

On-screen text: **17 WebMCP tools · this is one of them**

Cut the moment the useful sentence lands. Ten seconds, no more.

## 0:10 — Save the Reels

Paste all four at once, do not type:

```
Save these reels: <url1> <url2> <url3> <url4>
```

The page moves to the library and the Reels appear while the agent is still speaking.

> Say: "Four reels I saved on Instagram, handed over in one line."

⚠️ `save_reels` spends with no approval card, deliberately. Do not imply it asked.

## 0:20 — The centrepiece · plan it, and it asks

```
Use the reels I just saved and plan me 2 days in Tokyo, 15 to 16 November 2026
```

**It stops and asks how you like to travel**, because Astrail has nothing remembered for this
account and will not spend the trip allowance on a generic first draft. Nothing has been charged
and no approval card has appeared yet.

Answer out loud:

```
easy access to public transport, good sushi, not too rushed
```

The approval card renders that back, the words the AGENT passed, which may be a paraphrase of what
you said. If it is not your phrasing, decline and rephrase; nothing has been spent. Approve.

> Say: "Reels into a real trip. It asks how I travel first, because it has nothing saved for me
> yet, and it asks on the page rather than in chat. That answer is what it learns from."

⚠️ **Do not say "it read my library itself" here.** You pasted those four URLs ten seconds ago in
this same conversation, so the agent can hand them straight to `plan_trip_from_reels` without ever
calling `list_saved_reels`, and your own footage shows the URLs sitting in the scrollback. If a
rehearsal shows it genuinely calling `list_saved_reels`, you can say so. Otherwise say what the
take shows.

**Then CUT.** On-screen over the cut: **generation takes about two minutes · cut for time**

Come back on the finished trip: map, numbered pins, route.

## 0:52 — Change it by saying so

```
Add Tokyo Disneyland to day 2
```

> Say: "The trip is not a static output. It asks me on the page first, then finds the place itself
> and redraws the route. The day summaries rewrite themselves to match."

⚠️ The card appears BEFORE the lookup and reads "It will be looked up as…", future tense. Do not
narrate the geocode as already done.

Approve, let the map redraw, cut once the summaries update. Speed up 1.5x if it drags.

## 1:10 — Save the Osaka Reels

**Start a NEW ChatGPT conversation first.** This is what makes the next beat work: in the same
chat, the agent has just heard you say your preferences and may resend them, which suppresses
recall entirely.

```
Save these reels: <osaka url1> <osaka url2>
```

Ten seconds. No narration needed, or one line: "Two more reels, a different city."

## 1:20 — It remembered

```
Use the reels I just saved and plan me 2 days in Osaka, 17 to 18 December 2026
```

State no preference. **Cut straight to the populated card.**

The card names what Astrail remembers and offers a field to say otherwise:

```
Plan a trip from 2 reels
Dates: 2026-12-17 to 2026-12-18
No preferences given — Astrail will try to recall what it remembers
about how you travel: <what mem0 actually stored>
This uses your trip allowance.

Different this trip? (optional)  [ ______________________ ]

[ Try what it remembers ]   [ Not now ]
```

⚠️ **Do not read that middle line off this page.** The facts come back as mem0's OWN prose, not
your words: the backend stores `Travel preferences: <what you said>` and lets mem0 infer, so it may
come back rephrased. **Screenshot the real card in rehearsal and narrate what it actually says.**

"Astrail remembers: …" is the HOME SCREEN line, not the card. Two different surfaces.

> Say: "New trip, new city, and I said nothing about how I travel. It remembered from the first
> one, and it still asks."

**Cut here.** The card is the payoff. Do not run a second generation.

On-screen text: **remembered from trip 1 · still asks**

## 1:40 — How it is built · 87 words, 48s

Read this over whatever visual you make. The counts are on screen so the narration does not carry
them.

> Astrail registers seventeen tools with `document.modelContext.registerTool`, and what matters is
> where they run. `execute` runs inside the page.
>
> A tool already holds the trip you are looking at, your session, and the same state setters a
> click uses. When the agent shows you a day, the page's own `showDay` runs. Not an API it hoped
> would work.
>
> Writes go to FastAPI, owner-checked, and every edit to your trip stops for an approval card on
> the page, not a question in chat.
>
> And the agent can now read what Astrail remembers, and offer it while planning.

On-screen text through this section:
**17 tools · 14 global · 3 trip-scoped · 6 with no account**
**every stop says where it came from: the reel, Astrail, or you**

That second line is where provenance survives, now that the evidence beat is cut.

⚠️ Read at 120 to 140 words per minute. If it feels rushed you are over budget, and over 3:00 is
a hard fail.

## 2:28 — Close

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

1. **The 0:00 "what can I do here" beat.** It shows introspection but little visible product
   value. Cutting it opens on the Reels landing, which is a stronger first frame anyway.
2. Trim the architecture narration and push more onto on-screen text.
3. Shorten the close to two seconds.
4. Cut the add-place beat to approval, hard cut, changed map.

**Never cut:** the plan beat with its question, or the memory card. Those two are the submission.

## What we deliberately cut

| | Why |
|---|---|
| The 22-second hook and tagline | "Show it working in the first 10 to 15 seconds" and "save your story for the description" |
| The Instagram B-roll | Setup, not product |
| The compressed generation | "Cut all load times." A jump cut and one line of text does it |
| A second generation | "One strong example." The card is the memory payoff |
| **The evidence beat** | 16 seconds we do not have. Provenance survives as on-screen text over the architecture section, and the written description carries it properly |
| 3D buildings | No tool sets it, and the seconds are worth more elsewhere |
| Hotels, hub view | Search is off; hub declines everywhere |
