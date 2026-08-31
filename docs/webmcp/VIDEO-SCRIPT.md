# The submission video — shot list

**Hard requirements:** under 3 minutes · public YouTube · **with audio** · covers what was built
**and how WebMCP was used**. Both halves are graded; a beautiful product demo that never explains
the WebMCP integration loses marks on "thoughtful use of WebMCP".

Every prompt below is quoted exactly as it should be typed, and every response beat is something
the code actually does today. Nothing here is aspirational.

## The one structural decision

**Do not build the video around a live generation.** It takes 60–180s — most recently a measured
123.5s, of which restaurant enrichment was roughly 94% — and the budget is 180s total. It would eat
the whole video. (It is *not* an unproven path: a full generation ran through an agent on 30 Aug,
approval card to finished map. Like everything else here it ran against a backend on `localhost`;
nothing in this repository has been run on a deployed URL, because there is no deployment yet.)

So the backbone is **`/app/trip/demo`** — the sample trail. It needs no account, spends nothing,
renders instantly, and every tool on it answers. Generation gets one short pre-recorded beat,
clearly time-compressed and labelled as such.

## Time budget

| | Beat | Runs |
|---|---|---|
| 0:00–0:15 | The problem, in the user's own words | 15s |
| 0:15–0:35 | Site tools appear — the WebMCP mechanism, on screen | 20s |
| 0:35–1:00 | "What can I do here?" — the discoverability fix | 25s |
| 1:00–1:35 | "Why is this here?" — evidence provenance | 35s |
| 1:35–2:05 | The agent drives the map | 30s |
| 2:05–2:35 | Generation, time-compressed | 30s |
| 2:35–2:55 | How it is built | 20s |
| | **Total** | **2:55** |

---

## 0:00 — Open on the complaint, not the product

Screen: the Astrail map, quiet. Text on screen, quoted because it is real user feedback:

> *"It's unclear how to navigate the website — where to click, how to choose the reels, how to
> start generating a trip."*

Say: "That's real feedback on our travel planner. The usual fix is redesigning the buttons. We
tried something else — we made the app something you can talk to, and let the agent do the
finding."

**Why this opening:** it is the honest origin of the work, and it makes every later beat land as
a fix rather than a feature. Do not open with the product tour.

## 0:15 — Show the mechanism before using it

Screen: ChatGPT desktop's built-in browser, open on `/app/trip/demo`. Click the **Site tools**
arrow in the address bar. Let the list render fully on camera.

Say: "Astrail registers its tools with `document.modelContext.registerTool`. ChatGPT discovers
them from the page — no server, no plugin, no configuration."

**Keep the on-page WebMCP chip in frame for the whole video.** When the tool count changes later,
that is scoped registration explained without a word of narration.

## 0:35 — The beat the entry is actually about

Type exactly:

> **What can I do here?**

The agent calls `get_app_state`. Signed out, it answers with: the public sample trail, that there
is no account so it will say nothing about your own library, the six tools that work, and that
saving, planning and editing need an account.

⚠ **The agent will read out five, not six.** Six are offered — that is what the Site tools list and
the chip show — but `get_app_state` leaves itself off its own list of next steps, so it recommends
the other five. Say "six tools, and it points you at five of them"; narrating a flat "six" while
the agent enumerates five is the kind of mismatch a judge notices on screen.

Say: "It reads the page's own state and tells you what's possible — including what *isn't*. It
knows editing will fail here, so it doesn't offer it. That's the discoverability problem solved by
removing the need to find the button."

**This is the beat no other entry will have.** Do not cut it for a flashier one.

## 1:00 — Evidence, which is the product's whole argument

Type exactly:

> **Why is stop 1 on this trip?**

`get_place_evidence` returns Akasaka Station with a verbatim Instagram caption quote and
`reel:` — the actual Reel it was extracted from.

Then, immediately, the contrast. Type exactly:

> **And why is stop 4 there?**

Stop 4 is **Ichiran Shibuya**, `suggested_by_astrail`. It answers with its reasoning and a
`research:` link, and **offers no Reel, because it has none** — no `reel:` line, no Instagram URL.
(It does not print a sentence saying so: a suggested stop has no Reel to be missing, so none is
owed. The "no source Reel recorded" line is for a reel-quoted stop whose URL is absent.)

Say: "Every stop shows where it came from. This one is quoted from a Reel. This one Astrail
suggested, and it says so rather than dressing a suggestion up as evidence."

**This 35 seconds is the strongest content in the video.** The sample trail deliberately carries
three provenance kinds — reel-quoted, Astrail-suggested, and a stop the traveller asked for — so
the honesty is demonstrable rather than claimed.

## 1:35 — The agent moves the map you are looking at

Type:

> **Show me day 2 on the map**

`show_on_map` drives the same setters a click uses, so the camera flies and the day chip goes brass.

**Do not ask for 3D.** `set_map_mode` takes `route` or `hub` only — there is no 3D mode, and that
prompt returns an error. The extruded buildings are `minzoom: 15` while the deepest tool-driven
camera is zoom 14, so no tool can reach them; only the popup's street-level button can, by click.
If you want the buildings on camera, click into a pin — and narrate it as the human's move, not the
agent's.

Say: "These tools run *in the page*. They hold the loaded trip and the same state setters a click
uses — which is why the map moves while you watch, instead of an agent describing a map to you."

**This is the WebMCP-versus-a-server-MCP argument, shown rather than asserted.** A backend MCP
server could return JSON about a trip. Only WebMCP can move the map in front of the human.

## 2:05 — Generation, honestly compressed

Pre-recorded, sped up, with a visible "time-compressed" label. Do not fake the duration.

Type exactly:

> **Plan me a Tokyo trip from these Instagram Reels:**
> **https://www.instagram.com/reel/DYGH3jFBZHz/ https://www.instagram.com/reel/DYM_I5IvLSv/**
> **https://www.instagram.com/reel/DXwcVVliX3B/ Start date <10 days out>, end date <+2 days>.**
> **Mid-range budget, walkable days.**
>
> Recompute the dates on the day — 10 days out keeps the trip inside Open-Meteo's ~16-day
> forecast window, so the weather stage actually returns something.

Show: the approval card appearing **before** anything is spent, then the wait screen narrating
real stages, then the finished map.

Say: "Planning takes a couple of minutes and costs real money, so the agent has to ask first. It
polls a progress tool and narrates the actual stages — it never invents progress."

## 2:35 — How it is built, because that is graded

Screen: `frontend/lib/webmcp/` in an editor, then the raw call.

Say: "Sixteen tools in two scopes. Global tools live in the app shell; trip tools register when a
trip opens and unregister when you navigate away — which is the tool count you watched change.
Every tool that can return an Instagram caption is annotated `untrustedContentHint`, because Reel
captions are attacker-controlled text. Stops are addressed by map-pin number, never by UUID, so
the agent's vocabulary is the same as the user's."

Close: "Astrail turns scattered travel inspiration into the route you actually take — and now you
plan it by talking, while the map moves in front of you."

---

## Recording notes

- **GPT-5.6 Sol or Terra.** Luna has WebMCP disabled and will silently show no tools.
- **Settings → Browser → Permissions → Enable site tools** must be ON before recording.
- Site tools are **not available in Enterprise or Edu workspaces**.
- Record `/app/trip/demo` **signed out**. It needs no credential, spends nothing, and is the path a
  judge will take. It also means no account details on camera.
- Do a silent rehearsal pass first and check the tool list renders — a cold page can take a beat.
- **Watch which one it uses.** A site can register tools; it cannot make an agent call them, and
  the choice is ChatGPT's rather than the page's. On a bare prompt it has been seen driving the
  browser directly instead — clicking through the UI, no tool call, no approval card, and the beat
  proves nothing on camera even though it looks like it worked. If that happens, ask it to use
  Astrail's own tools and shoot the beat again. Nobody has tested whether saying it once holds for
  the rest of a session, so check every beat rather than assuming the first one fixed it.

## If something fails on camera

| Fails | Do this |
|---|---|
| Tool list empty | Wrong model or site tools off. Both are in Recording notes; fix and restart |
| The page moves but no tool fired | ChatGPT drove the browser instead. Ask it to use Astrail's own tools and reshoot the beat — see Recording notes |
| A tool errors | Cut to the sample trail — every tool there answers, which is why it is the backbone |
| Generation stalls | It is pre-recorded. Use the recording |
| Over 3:00 | Cut generation (2:05) first, then trim the map beat (1:35) to the day fly-to. **Never cut 0:35 or 1:00** |
