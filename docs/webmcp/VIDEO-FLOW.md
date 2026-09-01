# The demo video — locked flow

> **Locked 2026-08-31 by Shaun.** This is the flow we shoot. It supersedes the beat list in
> `DEMO-RUN.md`, which stays as the prompt reference and the PASS criteria for each beat.
>
> Requirement being satisfied: *"A <3-minute public YouTube video showing a clear demo with audio
> that covers what you built **and how you used WebMCP**."* The architecture segment is therefore
> mandatory, not optional.
>
> **Tagline: make your trip inspiration executable.**

## ⚠️ Before you hit record

**Be signed in already. Do NOT film the login.** The video is public on YouTube permanently. A
password visible on screen — or reconstructable from keystrokes — publishes the credential we
deliberately kept off the landing page and put in Devpost's private field. If you want to show
that auth exists, show the sign-in page without typing into it.

Account state: **zero reels, zero trips.** The orientation beat is only honest on an empty account.

## The flow · 3:00

| | Beat | Runs |
|---|---|---|
| 0:00–0:22 | **The hook** — problem, then the tagline | 22s |
| 0:22–0:32 | Instagram, three saved reels — the problem made concrete | 10s |
| 0:32–0:47 | Astrail home · `What can I do here?` | 15s |
| 0:47–1:05 | `Save these reels: <3 urls>` — the page fills as it speaks | 18s |
| 1:05–1:35 | `Use the reels I just saved and plan me 2 days in Tokyo, 15 to 16 November` — narrate over the compressed wait | 30s |
| 1:35–2:05 | `Add Tokyo Disneyland to day 1` — card, approve, map redraws, summaries rewrite | 30s |
| 2:05–2:20 | Zoom the map in on the new pin — buildings extrude | 15s |
| 2:20–3:00 | **How it's built** — the WebMCP architecture | 40s |

### 0:00 — The hook

Everyone has a trip they mean to take. The inspiration is already there — saved reels, a
collection you keep adding to. And then nothing happens, because going from idea to execution is
tedious: you research the same places again across a dozen sources and plan the whole thing by
hand. So the reels just sit there.

**Astrail is a WebMCP-powered, AI-native trip planner that makes your inspiration executable.**

The problem in one line: *the inspiration is scattered, the planning is manual, and the trip never
gets made.*

### 0:22 — Instagram, three reels

Show the saved collection. Scattered information, sitting unused. Ten seconds, no narration
needed beyond the hook still landing.

### 0:32 — `What can I do here?`

Empty account. It names that you have no reels and no trips and points at the next step. This is
where a viewer sees WebMCP is actually in play — keep the dock in frame.

### 0:47 — `Save these reels: <urls>`

Paste the three. The page moves to the library and the reels appear **while the agent is still
speaking** — `save_reels` awaits its reveal, so the tool cannot report a save the screen has not
caught up with.

⚠️ Narrate consent accurately: `save_reels` spends with **no approval card**, deliberately. The
planning asks; the saving does not.

### 1:05 — Plan it

```
Use the reels I just saved and plan me 2 days in Tokyo, 15 to 16 November
```

**The main feature, and a better WebMCP beat than pasting links:** the agent has to call
`list_saved_reels`, read the URLs out of the library, and feed them into `plan_trip_from_reels`.
Two tools cooperating on one ordinary sentence — you never see a URL and you never typed one.

An approval card appears before anything is spent, because this costs real credit. Approve it,
then narrate what the pipeline is doing over the compressed wait. **Say the real number: ~123.5
seconds, restaurants most of it.** A judge who suspects a hidden wait trusts nothing else.

Dates are REQUIRED by the tool, so give them. "Plan me 2 days" alone makes the agent stop and ask,
which is an awkward pause mid-take.

### 1:35 — `Add Tokyo Disneyland to day 1`

The trip is not a static output — this is where that lands. Approval card on the PAGE, not a
question in chat. Approve, the map redraws, and the day summaries rewrite themselves so the prose
matches a trip that just changed.

Astrail geocodes the place itself rather than asking for coordinates.

### 2:05 — Into 3D

Just zoom the map in on the new Disneyland pin. Buildings extrude at z15, so scrolling in is
enough. (The evidence popup also has a "Zoom in for 3D" button that jumps straight to z17 if you
prefer one click — same result.)

**One thing to get right in the narration:** no tool sets 3D — `set_map_mode` is `route`/`hub`
only — so do not ask the agent for it on camera and do not imply it did this. The honest framing
is the better one anyway: the agent put the stop on the map, you looked around it.

### 2:20 — How it's built · the script

Read this over whatever visual you make. ~110 words, lands at about 40 seconds at a normal pace.

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

**If you are running long**, this is the 25-second cut. Drop the middle paragraph's last two
sentences and the whole third one:

> Astrail registers sixteen tools with `document.modelContext.registerTool` — thirteen across the
> app, three more once a trip is open. The part that matters is where they run: `execute` runs
> inside the page, not on a server, so a tool already holds the trip you're looking at and the same
> state setters a click uses. Reads never leave the browser. Anything that changes your trip stops
> for an approval card on the page.

**Every number in it is verified:** 13 global + 3 map = 16 (`lib/webmcp/tools/index.ts`), 6
signed-out on `/app/trip/demo`. Do not round them on camera — a judge can count the tools in the
address bar.

The one idea to land: **`execute()` runs inside the page.** Not on a server — which is why a tool
already holds the loaded trip, the session, and the same state setters a click uses. An agent
action and a user action are the same event.

Worth one sentence if it fits: six tools with no account, sixteen once a trip is open — the app's
capabilities grow with its state.

## Cut deliberately

| | Why |
|---|---|
| The signed-out 6-vs-16 beat | Folded into one architecture sentence; not worth 20s of its own |
| A separate provenance beat | The Disneyland add carries it — a stop with no Reel, added on camera |
| Hotels, hub view | Search is off; hub declines everywhere |
| Asking the agent for 3D | No tool sets it; the request errors |
| Filming the login | Publishes a credential we deliberately kept private |
