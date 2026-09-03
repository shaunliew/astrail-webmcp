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

> Paste everything inside the fence into Devpost's About field.
>
> Cut from 2,226 words. The tell in the long version was not any one sentence, it was that every
> section ended on a punchline. Concrete details read human; connective rhetoric reads generated,
> so the numbers stayed and the flourishes went.
>
> Zero em dashes.

```markdown
## Inspiration

Instagram makes it easy to save a Reel about somewhere you want to go, then gives you nothing to
do with it. Our own folders had about a hundred places across nine countries. When the dates
finally got booked, the fastest route from that folder to a real itinerary was still twenty
browser tabs, so we never opened it and planned off search results instead.

So we built the conversion. Paste Reel links and a multi-agent pipeline on the OpenAI Agents SDK
pulls the places out of the captions, verifies each one exists, checks weather and routes, and
groups them into days by geography. Anything that will not verify gets dropped. It takes 60 to 180
seconds. The run we instrumented took 123.5.

Then we showed it to people and got this back:

> "It's unclear how to navigate the website, where to click, how to choose the reels, how to start
> generating a trip."

We had spent a sprint treating that as a copy problem. It was not. The tool was not hard to
understand, it was hard to operate, and we could either keep redesigning buttons or remove the
need to find them. That is what took us to WebMCP.

## What it does

Astrail turns saved Instagram Reels into a routed trip on a live 3D map, and you drive it by
talking to ChatGPT.

Say "save these reels" and paste some links; it saves them and starts pulling places out. Say
"plan me two days in Osaka from those" and it shows an approval card with the cost, runs the
pipeline, narrates each stage, and hands back a routed map. Say "add Tokyo Disneyland to day 2"
and it asks you on the page, finds the place, adds it, and redraws the route.

Ask why a stop is on your trip and you get one of three answers: the caption quote from the Reel
it came from with a link to that Reel, Astrail's reasoning where it suggested the stop, or a note
saying you asked for it. Where we cannot source a fact, like opening hours, the space stays empty.

It also remembers how you travel. Tell it once and the next trip recalls it, names what it
remembered on the card, and still asks before spending anything.

None of that is the agent working alone. It plans, you approve. It offers what it remembered, you
can override it. Before WebMCP those two halves could not meet: you could read the itinerary but
not change it, and an agent could describe your trip but never touch it.

## How we built it

Seventeen tools registered through `document.modelContext.registerTool()`, in two scopes. Fourteen
in the signed-in app shell, three more only while a trip map is mounted, and six that work with no
account on a public sample trail.

The important part is where they run. A backend MCP server can describe a trip. Only WebMCP can
move the map the person is looking at. Because `execute()` runs in the page, a tool already has
the loaded trip, the session, and the same React state setters a click uses. Ask for day 2 and the
page's own `showDay` runs, so the camera flies and the day chip lights up as if you had clicked.

The agent inherits our security model instead of bringing its own. Reads run under the same
row-level security a human gets, no access token crosses the tool boundary, and every edit to your
trip stops for an approval card on the page rather than a question in chat.

Tools address stops by pin number, so "move stop 7 to day 3" works and no UUID ever reaches the
agent. Reel captions are text an attacker can write, so every tool whose output can carry one is
annotated `untrustedContentHint`, and the extraction agents run behind `input_guardrail`
tripwires.

We also had a second model reviewing. Every plan and diff went to Codex before it landed, and it
caught things we missed, including a bug inside a fix we thought was already correct.

Stack: Next.js 15, React 19 and Mapbox GL on Vercel; FastAPI on Render; Supabase; the OpenAI
Agents SDK; mem0; Apify.

Astrail existed before the submission period, so to be clear about the split: everything in
`frontend/lib/webmcp/` was written on or after 26 August, along with five owner-checked edit
endpoints, the rebuilt map, and the signed-out sample trail. The memory engine is from July and we
do not claim it as challenge work. What is new is that an agent can reach it. Dated commit list in
`docs/webmcp/WHATS-NEW.md`.

## Challenges we ran into

The worst one was a flaw in our own product that only showed up once an agent was driving.

Astrail looks up what it remembers about you only when the preferences box arrives empty, on the
logic that what you typed today beats what you said three trips ago. It saves a new memory only
when that box arrives full. Those conditions never overlap. So an agent leaving the field blank
could recall forever and never teach it anything, and the manual form, which pre-fills that box
from your profile, was quietly switching recall off on the other path. Nobody had noticed because
no path had exercised both halves. Three changes fixed it: the planning tool asks how you travel
when it has nothing stored, the card names what it remembered before you approve, and a new tool
reads the store back.

Chrome's `use-webmcp-tool` hook cost us a day. It never catches the promise `registerTool` returns,
and since aborting the signal is how a tool unregisters, every navigation threw an unhandled
`AbortError` across the app. We could not patch it from outside, because `registerTool` is a
non-writable property of a native interface, so we wrote our own. About 144 lines.

Making an agent's action feel like your own took longer than expected. Early versions had a tool
call an API and then hope the page noticed, which is a second rendering path, and those drift. Now
a mutation will not resolve until the UI has caught up.

And Travala's travel MCP, which we used for hotel search, moved to OAuth mid-challenge and started
returning 401 on every call. Hotel search is off in this build, and the map tools say so rather
than flying the camera at nothing.

## Accomplishments that we're proud of

WebMCP fixed the thing users actually complained about, which was the whole point of trying it.

Getting Reels in used to be copy, switch tab, paste, repeat, then find a separate button to start
extraction. Now you paste four links in one message. A finished trip used to be frozen at every
layer, with no endpoint and no frontend mutation. Now five tools edit it, each behind an approval
card.

Beyond that, nothing reaches the map unattributed, and a contract test fails if our own copy ever
promises a caption quote for a stop that has none, because the false version of that sentence
reads better than the true one. Our tests check the README's tool table against the registry too,
so a stale claim goes red rather than shipping.

## What we learned

None of us had used WebMCP before this. It was announced, we read the spec, and started.

It is a DOM API, not a server. We spent the first evening looking for the deployment story before
realising there is not one. Your tools ship with your JavaScript.

Where you register matters as much as what you register. App shell versus trip page is the
difference between a tool that always exists and one that appears only when there is something for
it to act on.

The description field does more work than the code behind it. It is the only place to teach an
agent when to call something, and it is captured at registration, so it cannot say anything
dynamic. We rewrote ours constantly.

And the page cannot talk back. When someone clicks a pin, the agent has no idea. That asymmetry
shaped more of the design than we expected.

## What's next for Astrail

Group trips. Nobody plans a holiday alone and right now Astrail assumes you do. Several people on
one trip, each with their own agent, editing the same map. Everything here already points that
way, since an agent edit and a human edit are the same event.

Memory that watches rather than only listening. Right now it remembers what you tell it. The trips
you actually keep say more: which neighbourhoods, how far you will really walk, whether you fill a
day or leave it open.

Flights, so it covers the whole trip. Search and comparison, not booking. There are no payments in
Astrail.

And hotel search back on, when there is a provider we can rely on.
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
Astrail existed before 25 August, as a manual trip planner. You pasted Reel links into a form,
waited, and got back an itinerary you could read but could not change.

Everything in frontend/lib/webmcp/ was written on or after 26 August. That is the seventeen WebMCP
tools, the registry behind them, their contract tests, the on-page approval cards, the agent
activity rail, and the WebMCP status chip. Five owner-checked FastAPI edit endpoints are new as
well, because until then the itinerary was immutable at every layer: no endpoint, no frontend
mutation, and row-level security that was SELECT-only.

Two more things were built during the period. The map was rebuilt so an agent would have something
worth driving, and a stop that came from a Reel now carries that Reel's own cover frame in its pin
and links back to the Reel itself. And /app/trip/demo is new: a finished sample trail that opens
signed out, with six of the seventeen tools, so the app can be evaluated without an account.

The memory engine (mem0) is NOT new. It was built between 7 July and 2 August and we do not claim
it as challenge work. What is new is that an agent can reach it, and finding out why it could not
was one of the more interesting things that happened to us. A tool now reads back what Astrail
remembers, the approval card names those preferences before you approve the spend and lets you
override them for one trip, and the planning tool stops and asks how you travel when it has
nothing stored. Before this, an account planned entirely by agent could recall forever and never
teach it anything.

The full commit-by-commit split, with dates, is in docs/webmcp/WHATS-NEW.md in the repo.
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
