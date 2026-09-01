# Devpost submission — paste-ready

> Start the draft NOW even with blanks. Devpost's own advice: a saved draft costs nothing and
> shows you which fields are still missing. A draft is **not** a submission — you must see the
> green button at the end.
>
> Long-form source: `SUBMISSION.md`. This file is the condensed version that goes in the form.

---

## Project name

```
Astrail
```

## Elevator pitch

```
Turn the Instagram Reels you saved into a routed, evidence-backed itinerary — then restructure it by talking, while the map redraws in front of you.
```

## Built with

```
webmcp, typescript, nextjs, react, tailwind, mapbox, python, fastapi, openai, supabase, postgresql, pgvector, apify, vercel, render
```

## About the project

*(paste as-is; it answers Devpost's four questions in order, but reads as a case rather than a
feature tour — which is what their halfway update warned about)*

```
## The problem

People collect travel inspiration and never use it. You save reels for months, and the trip never
gets planned — because going from a folder of clips to an actual route means researching every
place again across a dozen sources and assembling the days by hand.

We heard the same thing from our own testers, in almost these words: "It's unclear how to navigate
the website — where to click, how to choose the reels, how to start generating a trip."

That feedback is why this entry exists. We had already built the pipeline. What we had not solved
was the interface to it.

## Why WebMCP fits this, specifically

A backend MCP server can return JSON describing a trip. It cannot move the map the traveller is
looking at.

That is the whole argument, and Astrail is built so it is literally true. The tools run inside the
page, so they call the same state setters a click calls, on the same Mapbox instance already on
screen. The agent doesn't describe a change and ask you to reproduce it — the camera flies, the pin
grows, the day chip turns brass. Same map, same code path, same event.

They also inherit context instead of rebuilding it: the signed-in session, the trip in memory, the
camera you're actually looking at, whether a generation is still running. A remote server would
keep a second, staler copy of all of it.

And the agent's vocabulary is yours. Tools address stops by **map-pin number** — the numbers you can
see. "Move stop 7 to day 3" means the same thing to both parties. No UUID ever enters the
conversation.

## What this changes for the person using it

The fix for "I can't tell where to click" turned out not to be better buttons. It was removing the
need to find them. `get_app_state` lets the agent read the live page and answer "what can I do
here?" in the app's own terms — what you have, what's next, what's blocked.

Then you talk. Save these reels. Plan two days from them. Add a stop. Move that one to day 3. The
page moves as you speak.

## What people and agents can now do together

Turn scattered Instagram Reels into a routed, evidence-backed itinerary — and then **restructure it
conversationally while watching the map redraw**, with every agent action attributed and every
change to your trip stopping for approval on the page, not in chat.

Before, the itinerary was frozen: there was no edit path at any layer. You pasted five URLs by
hand, waited, and accepted whatever came out.

Every stop says where it came from. A stop lifted from a Reel carries the verbatim caption quote
and a link back to it. One Astrail suggested carries its reasoning. One you asked for says so.
Three provenances, one label on every pin — nothing on the map is unattributed, and the system
never dresses a suggestion up as a quote.

And it remembers how you travel. Say your preferences once — walkable days, ramen, nothing too
rushed — and a later trip planned **without** stating them recalls that and uses it. The recall is
deliberate rather than ambient: it runs only when you leave preferences blank, so whatever you say
now always beats whatever it remembers. Every remembered fact is listed, sourced, and deletable
under Settings, and the generation says on screen when it used them.

The memory engine pre-dates this hackathon; what is new is the agent's access to it. The planning
tool always accepted a preferences argument, but nothing told an agent the field outlived the
trip, so it went unset — and unset is both the condition that triggers recall and the condition
that saves nothing, which left agent-planned accounts empty. Now, when nothing is stated and
nothing is remembered, the tool stops before spending anything and asks how you travel; a second
tool lets the agent read back what Astrail holds. The approval card says when saved preferences
will be attempted, so the choice is visible at the moment you decide to spend. Attempted, not
guaranteed: recall is a semantic search that can miss, and the card does not promise what it
cannot.

## How we implemented WebMCP

Seventeen tools registered with `document.modelContext.registerTool()` — fourteen across the app,
three more the moment a trip is open, six of which work with no account at all.

Page-scoped tools unregister on navigation, so the catalogue reflects the app's state: open a trip
and it grows from fourteen to seventeen. Reads resolve in-page from the loaded trip with no network
call at all. Writes go to owner-checked FastAPI endpoints, and every tool that changes a trip
renders an approval card **on the page** and waits for a click before it mutates anything.

The generation is the hard part — 60 to 180 seconds behind a tool call. The EventSource lives in a
provider beside the map rather than inside `execute()`, so the tool returns in about a second while
the same stream drives both the agent's narration and the on-screen scene. They cannot disagree.

Every tool whose output can contain Reel-caption text carries `untrustedContentHint` — that
annotation is auditable here rather than decorative, because caption text is genuinely
attacker-controlled. No tool exposes the access token, fetches an arbitrary URL, or touches account
lifecycle.

## Honest limits

Hotel search is switched off in this build. There is no undo — Astrail has no inverse to offer, and
says so rather than pretending. Which tool an agent reaches for is ChatGPT's decision, not something
a site can control. Remembered preferences are soft guidance into restaurant
selection and the day summaries; they never restructure the route, and memory predates this
hackathon — it is listed as pre-existing in WHATS-NEW.md.
```

## Try it out

```
Repo:  https://github.com/shaunliew/astrail-webmcp
Live:  <fill after deploy>
```

## Video

```
<public YouTube URL — public, under 3 minutes, with audio>
```

## Testing instructions + credentials — PRIVATE FIELD

*(only Devpost and judges see this; the credentials are deliberately NOT on the landing page or in
the repo, because `NEXT_PUBLIC_*` is inlined into the client bundle)*

```
Open the live URL in the ChatGPT desktop app's BUILT-IN browser (not Safari or Chrome).
Model: GPT-5.6 Sol or Terra — Luna has WebMCP disabled.
Settings → Browser → Permissions → Enable site tools must be ON.
Look for the Site tools arrow in the address bar.

Sign in:  <email>  /  <password>

No account needed to look around: /app/trip/demo is a finished sample trip with six
working tools, open to anyone.

Try, in order:
  What can I do here?
  Save these reels: <any 1-5 instagram.com/reel/ links>
  Use the reels I just saved and plan me 2 days in Tokyo, 15 to 16 November
  Add Tokyo Tower to day 1
  Why is stop 1 on this trip?

Generation takes 60-180s and is real — it scrapes, extracts, de-duplicates, routes and
narrates. Ask "how's it going?" and the agent will narrate the actual stages.

If the agent starts clicking the page instead of using Astrail's tools, ask it to use
Astrail's own tools and repeat — which tool it picks is ChatGPT's decision, not the site's.
```

---

## Before you hit submit

- [ ] Live URL opened in a **fresh incognito window** on another machine — a cached login makes a
      working project look broken
- [ ] Repo public + licence visible in the About box **while logged out** ✅ verified 2026-09-01
- [ ] Video **public** on YouTube (not unlisted), under 3:00, **with audio**
- [ ] Teammates invited **and accepted** — cannot be added after the deadline
- [ ] Draft actually submitted — a saved draft is not a submission
- [ ] `WHATS-NEW.md` linked, showing dated commits for work after 25 Aug (eligibility)
