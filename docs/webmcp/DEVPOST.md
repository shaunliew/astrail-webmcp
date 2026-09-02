# Devpost submission — paste-ready, field by field

> Rewritten 2026-09-02 to match the actual submission form. Every claim here was checked against
> the code; the ones that were not survived an audit and were corrected. Do not paste anything
> from an older draft.
>
> **Deadline: Thu 3 Sep, 1:00 PM PT.** After that nothing can be edited.

---

## Project name

```
Astrail
```

Not AI-generated, and the guidance calls that out specifically. Keep it.

---

## Elevator pitch · 200 char limit

```
Plan a trip by talking. An agent reads your saved Instagram Reels, builds a routed itinerary you can edit out loud, and remembers how you travel without ever deciding for you.
```

172 characters. No em dashes.

---

## Built with

```
webmcp · document.modelcontext · typescript · react · next.js · fastapi · python · supabase ·
postgresql · mapbox-gl · openai-agents-sdk · gpt-5.5 · mem0 · apify · vercel · render · tailwindcss
```

---

## About the project

> Devpost asks for inspiration, what you learned, how you built it, and the challenges. The four
> judged questions are woven through rather than answered as a checklist, because that reads like
> a form and judges say they can tell.

```markdown
## Inspiration

We kept hearing the same thing from people testing Astrail: *"I can't tell where to click, how to
choose the reels, or how to start."*

That is not a pipeline problem. Astrail could already turn saved Instagram Reels into a routed,
evidence-backed itinerary. The problem was that the interface to it was a puzzle, and we had been
trying to solve it the usual way, with better affordances and clearer copy.

WebMCP offered a different answer: stop making people find the button, and let them say what they
want instead.

## What it does

Astrail turns the travel inspiration you already saved into a trip you can actually take.

Paste a few Instagram Reel links and it scrapes them, extracts the real places, verifies each one
exists, routes them into days, checks the weather and finds somewhere to eat. Every stop on the
map says where it came from: the verbatim caption quote from the Reel it was found in, Astrail's
own reasoning where it suggested one, or a plain note where you asked for it yourself.

With WebMCP, an agent does all of that by operating the page you are looking at. You say "use the
reels I just saved and plan me two days in Tokyo" and it reads your library itself, starts the
generation, narrates each stage, and hands you back a map. Then you say "add Tokyo Disneyland to
day 2" and it does, asking you on the page first, redrawing the route, and rewriting the day
summaries so the prose matches the trip you now have.

And it remembers how you travel. Say it once, and the next trip you plan without stating anything
recalls it, names it back to you on the approval card, and still offers you a field to say
otherwise. A remembered preference is a default, not a mandate.

## Why WebMCP fits this specifically

Astrail's value is an evidence-backed itinerary on a live 3D map. A backend MCP server could
return JSON about a trip. Only WebMCP can move the map the human is looking at.

Because `execute()` runs inside the page, a tool already holds the loaded trip, the signed-in
session, and the same React state setters a click uses. When the agent shows you day 2, it calls
the page's own `showDay`, so the camera flies, the pin grows and the day chip lights up exactly as
if you had clicked. There is no separate agent rendering path to keep in sync, because there is no
separate path.

That also means the agent inherits the security model instead of needing its own. No token ever
crosses the tool boundary. There is no arbitrary-URL fetch, no raw SQL tool, and no
account-deletion tool at any price.

## What people and agents can now do together

Turn a folder of saved Reels into a routed, evidence-backed itinerary, then restructure it
conversationally while watching the map redraw, with every agent action attributed and every
change to your trip stopping for approval on the page rather than a question in chat.

Before, the itinerary was frozen. There was no edit path at any layer: no endpoint, no frontend
mutation, and row-level security was SELECT-only. You pasted five URLs by hand, waited, and
accepted what came out.

The part we did not expect: memory only became reachable by an agent because of this work. The
planning tool always accepted a preferences argument, but nothing told an agent the field outlived
the trip, so it went unset, and an account planned entirely through an agent stayed permanently
empty. Now the tool asks how you travel when it has nothing to go on, stopping before it spends
anything to do it, and a second tool lets the agent read back what Astrail holds.

## How we built it

Seventeen tools registered with `document.modelContext.registerTool()`, in two scopes. Fourteen
live in the signed-in app shell. Three more register only while a trip map is mounted and
unregister when you navigate away, so the tool list a judge sees in the address bar grows as the
app's state does.

Three decisions shaped the rest:

**Pin numbers, never UUIDs.** Tools address stops the way you do: "move stop 7 to day 3". The
frontend resolves that to a real row, so no identifier a human cannot read ever crosses the
boundary, and 18 UUIDs would have eaten 43% of the output budget anyway.

**A 60 to 180 second generation behind a tool call.** `plan_trip_from_reels` returns in about a
second with a trip id and a next step. The EventSource lives in a provider beside the map, not
inside `execute`, so the same stream drives both the agent's narration and the on-screen wait, and
they cannot disagree. `get_trip_progress` self-throttles: called again too soon, it awaits the next
real stage event instead of returning nothing.

**Reel captions are attacker-controlled text.** Every tool whose output can carry one is annotated
`untrustedContentHint`, and the audit is machine-checked rather than asserted.

Stack: Next.js 15, React 19 and Mapbox GL on Vercel; FastAPI on Render with server-sent events;
Supabase for auth, Postgres and row-level security; the OpenAI Agents SDK for the pipeline; mem0
for preference memory; Apify for Reel scraping.

## Challenges

**Making an agent's action indistinguishable from your own.** Early versions had the agent call an
API and then hope the page caught up. The fix was to route every tool through the setters a click
already uses, and to make a mutation not resolve until the UI reflects it. When the sentence "done,
I moved it" reaches you, the map has already moved.

**Telling the truth on every surface.** This was harder than the features. A provenance chip
labelled every preferences row "Memory" whether memory had run or not. The activity rail announced
a read-only memory lookup as an irreversible change. An approval button promised an outcome the
backend's own semantic search could veto. Each of those was caught by review rather than by tests,
because they were claims rather than behaviour, and a passing test suite says nothing about whether
a sentence is true.

**A silent failure that looked like a broken integration.** A trailing slash pasted into an
environment variable turned every backend call into a 404 while the page loaded fine and the tools
still registered. The same character in the CORS origin rejected every real browser request. The
code now strips them, because a URL a human pastes will sometimes have one.

## What we learned

Tests prove behaviour, not honesty. Almost everything that went wrong in the last week was a
sentence: a label, a button, a comment claiming a guarantee the code did not have. The fix was
cross-model review, and it found something real on every single pass.

Also: jsdom has no cascade and no layout, so three styling defects shipped past 1800 passing tests.
Coverage that cannot see a failure mode is not coverage, and saying so is better than implying
otherwise.

## What's next

Per-stage checkpointing, so a restart mid-generation resumes rather than re-running. Destination-
scoped recall, so remembering that you like ramen does not follow you somewhere it makes no sense.
And hotel search back on, once there is a provider that answers.
```

---

## Try it out links

```
https://astrail-webmcp.vercel.app
https://github.com/shaunliew/astrail-webmcp
```

---

## Video demo link

```
<paste the YouTube URL once uploaded — must be PUBLIC, not unlisted-only if the rules say public>
```

---

## App Status

**Existing.**

### "If Existing, explain what you updated during the submission period"

```
Astrail existed before 25 August as a manual trip planner: paste Reel links into a form, wait,
receive an itinerary you could read but not change.

Everything in frontend/lib/webmcp/ is new, written on or after 26 August. That is the seventeen
WebMCP tools, the tool registry and its contract tests, the on-page approval cards, and the agent
activity rail. Two owner-checked FastAPI edit endpoints are new, because before this the itinerary
was immutable at every layer: no endpoint, no frontend mutation, RLS SELECT-only.

The memory engine (mem0) is NOT new; it was built 7 July to 2 August. What is new is that an agent
can reach it: a tool to read back what Astrail remembers, an approval card that names those
preferences and lets you override them per trip, and a planning tool that asks how you travel when
it has nothing stored. Before this, the agent path could not populate memory in practice, so an
account planned entirely by agent stayed empty.

The full commit-by-commit split is in WHATS-NEW.md at the repo root of docs/webmcp/.
```

---

## Live URL

```
https://astrail-webmcp.vercel.app
```

---

## Testing instructions + credentials — PRIVATE FIELD, judges only

```
Open this URL in the ChatGPT desktop app's BUILT-IN browser (not Safari or Chrome).
Use GPT-5.6 Sol or Terra. Luna has WebMCP disabled.
Turn on Settings > Browser > Permissions > Enable site tools.
The Site tools arrow appears in the address bar; the WebMCP chip is bottom-right on the page.

NO ACCOUNT NEEDED to see a finished trip: https://astrail-webmcp.vercel.app/app/trip/demo
That page opens signed out with six working tools. Try "why is stop 3 on this trip?"

To sign in and use all seventeen:
  Email:    <PASTE THE TEST ACCOUNT EMAIL>
  Password: <PASTE THE TEST ACCOUNT PASSWORD>

Prompts worth trying, signed in:
  "What can I do here?"
  "Save these reels: <any 1-5 Instagram Reel URLs>"
  "Use the reels I just saved and plan me 2 days in Tokyo, 15 to 16 November 2026"
  "Add Tokyo Disneyland to day 2"

A generation takes 60 to 180 seconds and spends real API credit, so the account has a daily cap.
The sample trail above costs nothing and needs no account.

If a prompt does not reach the tools, ask the agent to use Astrail's own tools and repeat it.
Which tool an agent reaches for is ChatGPT's decision, not something a site can control.
```

⚠️ **The credentials go ONLY in this field.** They are not in the repo, not on the landing page,
and not in any `NEXT_PUBLIC_*` variable — anything with that prefix is inlined into the public
JavaScript bundle.

---

## Public code repo

```
https://github.com/shaunliew/astrail-webmcp
```

MIT, detected by GitHub, visible in the About section. Verify in an incognito window before
submitting.

---

## Which agents or clients did you test your WebMCP tools with?

```
ChatGPT desktop app's built-in browser (GPT-5.6 Sol and Terra). Also Chrome 149+ with
chrome://flags/#enable-webmcp-testing for development.
```

---

## Which AI tools have you leveraged?

```
Claude Code (Anthropic) for implementation and review, and OpenAI Codex as a cross-model
reviewer on every batch. The Codex passes caught real defects the Claude reviews missed,
including a read-only tool being recorded as an irreversible write on the activity rail.
```

---

## Fields only Shaun can answer

- **Submitter type:** Team of Individuals
- **Country of residence:** Malaysia (and Zhi Hao's, if he is added)
- **Level of learning derived** — your call
- **AI value for your career** — your call
- **Teammates:** add Zhi Hao and confirm he ACCEPTS the invitation. This is irreversible after the
  deadline.

---

## Before you hit submit

- [ ] Video uploaded, **public**, under 3:00, with audio
- [ ] Repo checked in an **incognito window** — public, MIT visible in About
- [ ] Live URL opens in ChatGPT's built-in browser and the Site tools arrow lists the tools
- [ ] Credentials pasted into the private field, and nowhere else
- [ ] Teammates added AND accepted
- [ ] Not saved as a draft
