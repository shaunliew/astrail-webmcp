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

> Paste everything inside the fence into Devpost's About field. It uses Devpost's own headings so
> a judge scanning for a section finds it where they expect. The four judged questions are woven
> through rather than answered as a checklist, because a checklist reads like a form.
>
> Zero em dashes. Every factual claim checked against the code.

```markdown
## Inspiration

Instagram makes it effortless to save a Reel about somewhere you want to go, and then gives you
nothing to do with it. Our own saved folders had a hundred places across nine countries in them.
When the dates were finally booked, the fastest route from that folder to an actual itinerary was
still twenty browser tabs, so the folder stayed shut and the trip got planned off the first page
of search results.

That cost falls on the saver, not the researcher. Someone who takes one or two trips a year is
never going to hand-map thirty Reels to coordinates and opening hours.

So we built the conversion. Paste your Reel links and a multi-agent pipeline on the OpenAI Agents
SDK goes to work: separate agents for place extraction, restaurant grounding, itinerary narration
and hotel name localisation, with a read-only summariser over the top that reports what the others
decided and never overrides them. The late stages fan out concurrently and each is allowed to fail
on its own, so a weather API having a bad afternoon costs you a forecast rather than the trip.
Anything without a verifiable location gets dropped. The rest are grouped into days by geography
and land on a 3D map in 60 to 180 seconds. The run we instrumented took 123.5.

Then we put it in front of people, and got this back:

> "It's unclear how to navigate the website, where to click, how to choose the reels, how to start
> generating a trip."

We had already spent a sprint treating that as a copy problem. It was not. The tool was not hard
to understand, it was hard to operate. We could keep redesigning the buttons, or we could remove
the need to find them.

WebMCP is how you remove it.

## What it does

Astrail turns the Instagram Reels you save into a routed, evidence-backed trip on a live 3D map,
and you drive the whole thing by talking to ChatGPT.

Tell the agent to save some Reels and it saves them, starting extraction as it goes. Say "use the
reels I just saved and plan me two days in Osaka" and it opens an approval card with the cost
stated, starts the generation, narrates each stage as it runs, and hands you a routed map. Say
"add Tokyo Disneyland to day 2" and it asks you on the page, finds the place, adds the stop,
redraws the route, and rewrites the day summaries to match.

Every stop can be interrogated. Ask why stop 3 is on your trip and you get one of exactly three
answers: the verbatim caption quote from the Reel it came from, with a link to that Reel;
Astrail's own reasoning where it suggested the stop; or a plain note saying you asked for it.
Nothing sits on the map unattributed, and nothing is invented to fill a gap. If we cannot source
opening hours, the space stays empty.

It also remembers how you travel. State a preference once and the next trip recalls it, names what
it remembered on the approval card, and still asks before it spends anything.

## How we built it

**Seventeen tools registered through `document.modelContext.registerTool()`,** in two scopes:
fourteen in the signed-in app shell, and three more that register only while a trip map is
mounted. Six work with no account at all, on a public sample trail.

What matters is where they run. A backend MCP server could describe a trip. Only WebMCP can move
the map the person is looking at. Because `execute()` runs inside the page, a tool already holds
the loaded trip, the signed-in session, and the same React state setters a click uses. Ask for day
2 and the page's own `showDay` runs, so the camera flies and the day chip lights up exactly as if
you had clicked it. There is no second rendering path to keep in sync, because there is no second
path.

The agent inherits our security model rather than bringing its own. Reads run in the page under
the same row-level security, no access token ever crosses the tool boundary, and every edit to
your trip stops for an approval card on the page rather than a question in chat.

A few decisions we would make again:

**Pin numbers, never UUIDs.** Tools address stops the way a person does, so "move stop 7 to day 3"
works and no identifier a human cannot read crosses the boundary. The map, the itinerary and the
tools all count from the same trail.

**A two-minute job behind a one-second tool call.** `plan_trip_from_reels` returns in about a
second with a trip ID and a next step. The EventSource lives in a provider beside the map rather
than inside `execute`, so a single stream drives both the agent's narration and the on-screen
wait, and they can never disagree.

**Reel captions are attacker-controlled text, so we defend both ends.** In the browser, every tool
whose output can carry a caption is annotated `untrustedContentHint`, machine-checked by a
contract test. In the pipeline, the place extractor and the hotel localiser wrap their Agents SDK
runs in `input_guardrail` tripwires that reject a caption trying to steer the run.

The write surface behind the edit tools is new too. The itinerary used to be immutable at every
layer: no endpoint, no frontend mutation, and row-level security that was SELECT-only.

The stack: Next.js 15, React 19 and Mapbox GL on Vercel; FastAPI on Render with server-sent
events; Supabase for auth, Postgres and row-level security; the OpenAI Agents SDK for the
multi-agent pipeline; mem0 for memory; Apify for Reel scraping.

## Challenges we ran into

**The memory feature had a dead end nobody had noticed, and WebMCP is what exposed it.** The
backend searches memory only when the preferences field arrives empty, because what you typed for
this trip should beat what you said three trips ago. It writes a memory only when that field
arrives full. Those two conditions are mutually exclusive, so an agent that always left the field
empty could recall forever and never teach. Meanwhile the manual form pre-fills that box from your
saved profile, which counts as stating preferences and suppresses recall on that path entirely.
Closing it took three changes: the planning tool now stops and asks when it has nothing stored,
the approval card names what it remembered before you approve, and a new tool lets the agent read
the store back.

**Owning the registration.** Chrome's `use-webmcp-tool` hook never catches the promise
`registerTool` returns, and since aborting the signal is how a tool unregisters, every page
navigation threw an unhandled `AbortError` across the app. It cannot be fixed from outside:
`registerTool` is a non-writable property of a native interface, and an `unhandledrejection`
listener loses to handlers registered earlier during bootstrap. We wrote our own hook instead.
About 144 lines, and it keeps the dependency count at zero.

**Making an agent's action indistinguishable from your own.** Early versions had a tool call an
API and then hope the page caught up. The fix was to hand tools the page's own refresh hooks, and
to make a mutation refuse to resolve until the UI reflects it. By the time "done, I moved it"
reaches you, the map has already moved.

**A dependency died mid-challenge.** Travala's travel MCP moved to OAuth and started returning 401
on every call we used to make, so hotel search is switched off in this build. The app hides the
panel and both map tools say so in words rather than flying the camera at nothing.

## Accomplishments that we're proud of

**Nothing reaches the map unattributed.** Three kinds of stop, three honest answers, and a
contract test that fails if the copy ever promises a caption quote for a stop that has none. The
tempting version of that claim reads better than the true one, which is exactly why we made a
machine check it.

**The agent's click and yours are the same event.** Not a parallel API that mirrors the UI. The
same functions, the same state, the same map.

**An itinerary you can actually change.** Before this challenge it was frozen at every layer. Now
five tools edit it, each behind an approval card, each owner-checked and flag-gated on the way to
the database.

**Tests that check honesty, not just behaviour.** Our contract tests assert that the README's tool
table matches the registry, that the stated tool count is real, and that documented limitations
are still documented. When a claim stopped being true this week, a test went red.

## What we learned

**Tests prove behaviour, not honesty.** Nearly everything that went wrong in the last stretch was
a sentence, not a function. A status chip labelled every preferences row "Memory" whether memory
had run or not. An activity rail called a read-only lookup an irreversible change. A fully green
suite says nothing about whether a label is telling the truth, and a label that lies costs more
trust than a bug does.

**Understating is as expensive as overstating.** We caught ourselves calling two tools "unit-tested
only" hours after they had actually been run live. Nobody fact-checks a modest claim, which is
what makes it dangerous.

**Removing the need to find a button beats redesigning it.** The feedback that started this was
about navigation. We answered it with an interface you speak to instead of a better-labelled one,
and the first tool we wrote answers "what can I do here?" before anything else.

## What's next for Astrail

**Trips with more than one person in them.** Nobody plans a holiday alone, and right now Astrail
assumes you do. A trip should hold several people who can all see it and all change it, each with
their own agent working the same map. That is the version of this challenge's premise we actually
want to build: not one person and one agent, but a group and theirs, editing one shared thing
without standing on each other. Everything here already points that way, because an agent edit and
a human edit are the same event, so a second person is not a new code path.

**Memory that watches instead of only listening.** Today Astrail remembers what you tell it. The
trips you accept say far more: which neighbourhoods you keep, how far you will really walk,
whether you fill a day or leave it open. Learning your style from the trips you kept, rather than
from one sentence you typed once, is the difference between an app that stores a preference and
one that knows you.

**Flights, so it is the whole trip.** An itinerary that begins when you land is half a plan. Search
and comparison, not booking. There are no payments anywhere in Astrail and there will not be until
it can be done properly.

And hotel search back on, once there is a provider we can rely on.
```

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
