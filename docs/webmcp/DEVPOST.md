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

> Paste everything inside the fence into Devpost's About field. Devpost's own headings, so a judge
> scanning for a section finds it where they expect.
>
> Written as prose rather than bold-led bullet lists. The previous draft opened nine consecutive
> paragraphs with a bold label and a full stop, which reads as assembled rather than told.
>
> Zero em dashes. Every factual claim checked against the code.

```markdown
## Inspiration

Instagram makes it effortless to save a Reel about somewhere you want to go, and then gives you
nothing to do with it. Our own folders had a hundred places across nine countries sitting in them.
Every time the dates finally got booked, the fastest route from that folder to a real itinerary
was still twenty browser tabs, so the folder stayed shut and the trip got planned off the first
page of search results.

That cost lands on the saver, not the researcher. Nobody who takes one or two trips a year is
going to hand-map thirty Reels to coordinates and opening hours.

So we built the conversion. Paste your Reel links and a multi-agent pipeline on the OpenAI Agents
SDK goes to work: separate agents for pulling places out of captions, grounding restaurants,
writing the day narration, and localising hotel names, with a read-only summariser over the top
that reports what the others decided and never overrides them. The late stages run concurrently
and each is allowed to fail on its own, so a weather API having a bad afternoon costs you a
forecast rather than the trip. Anything without a verifiable location gets dropped. The rest are
grouped into days by geography and land on a 3D map in 60 to 180 seconds. The run we instrumented
took 123.5.

It worked. Then we put it in front of people, and got this back:

> "It's unclear how to navigate the website, where to click, how to choose the reels, how to start
> generating a trip."

We had already spent a sprint treating that as a copy problem. It was not. The thing was not hard
to understand, it was hard to operate. We could keep redesigning the buttons, or we could get rid
of the need to find them.

That is what pulled us into WebMCP.

## What it does

Astrail turns the Instagram Reels you save into a routed, evidence-backed trip on a live 3D map,
and you drive the whole thing by talking to ChatGPT.

Tell the agent to save some Reels and it saves them, starting extraction as it goes. Say "use the
reels I just saved and plan me two days in Osaka" and it opens an approval card with the cost
stated, starts the generation, narrates each stage while it runs, and hands you a routed map. Say
"add Tokyo Disneyland to day 2" and it asks you on the page, finds the place, adds the stop,
redraws the route, and rewrites the day summaries to match.

Every stop can be interrogated. Ask why stop 3 is on your trip and you get one of exactly three
answers: the verbatim caption quote from the Reel it came from, with a link to that Reel;
Astrail's own reasoning where it suggested the stop; or a plain note saying you asked for it.
Nothing sits on the map unattributed, and nothing is invented to fill a gap. Where we cannot
source opening hours, the space stays empty.

It also remembers how you travel. State a preference once and the next trip recalls it, names what
it remembered on the approval card, and still asks before it spends anything.

## How we built it

Astrail registers seventeen tools through `document.modelContext.registerTool()`, in two scopes.
Fourteen live in the signed-in app shell. Three more register only while a trip map is mounted,
and unregister when you navigate away. Six work with no account at all, on a public sample trail.

What matters is where they run. A backend MCP server could describe a trip. Only WebMCP can move
the map the person is looking at. Because `execute()` runs inside the page, a tool already holds
the loaded trip, the signed-in session, and the same React state setters a click uses. Ask for day
2 and the page's own `showDay` function runs, so the camera flies and the day chip lights up
exactly as if you had clicked it. There is no second rendering path to keep in sync, because there
is no second path.

The agent inherits our security model rather than bringing its own. Reads run in the page under
the same row-level security a human gets, no access token ever crosses the tool boundary, and
every edit to your trip stops for an approval card on the page rather than a question in chat.

Two smaller decisions we would make again. Tools address stops the way a person does, so "move
stop 7 to day 3" works and no identifier a human cannot read ever crosses the boundary; the map,
the itinerary and the tools all count from the same trail. And because Reel captions are text an
attacker can write, we defend both ends of them: in the browser every tool whose output can carry
a caption is annotated `untrustedContentHint`, machine-checked by a contract test, and in the
pipeline the place extractor and the hotel localiser wrap their Agents SDK runs in
`input_guardrail` tripwires that reject a caption trying to steer the run.

The write surface behind the edit tools is new too. The itinerary used to be immutable at every
layer: no endpoint, no frontend mutation, and row-level security that was SELECT-only.

We also built this with a second model in the loop. Every plan and every diff went to OpenAI's
Codex for review before it landed, and more than once it caught something our own review had
missed, including a bug inside a fix we had already convinced ourselves was correct. Two models
disagreeing about the same diff turned out to be a cheaper quality gate than either one reviewing
twice.

The stack: Next.js 15, React 19 and Mapbox GL on Vercel; FastAPI on Render with server-sent
events; Supabase for auth, Postgres and row-level security; the OpenAI Agents SDK for the
multi-agent pipeline; mem0 for memory; Apify for Reel scraping.

Worth being explicit about what is new, since Astrail existed before the submission period. Back
then it was a form: you pasted Reel links, waited, and got an itinerary you could read but not
change. Everything in `frontend/lib/webmcp/` was written on or after 26 August, along with the
five owner-checked edit endpoints behind it, the rebuilt map, and the signed-out sample trail. The
memory engine is older, built in July, and we do not claim it as challenge work; what is new is
that an agent can reach it. The dated, commit-by-commit split is in `docs/webmcp/WHATS-NEW.md`.

## Challenges we ran into

The hardest one was a flaw in our own product, and we only found it because an agent was driving.

Astrail searches memory for what it knows about you only when the preferences box arrives empty,
on the reasoning that what you typed today should beat what you said three trips ago. It saves a
new memory only when that box arrives full. Those two conditions never overlap. So an agent that
always left the field blank could recall forever and never teach it anything, while the manual
form, which helpfully pre-fills that box from your profile, was quietly switching recall off on
the other path. Nobody had noticed, because until now no path had exercised both halves. Fixing it
took three changes: the planning tool stops and asks how you travel when it has nothing stored,
the approval card names what it remembered before you approve the spend, and a new tool lets the
agent read the store back to you.

Then there was the registration hook. Chrome ships one, `use-webmcp-tool`, and we started there.
It never catches the promise that `registerTool` hands back, and since aborting the signal is how
a tool unregisters, every page navigation threw an unhandled `AbortError` across the whole app. We
tried to patch it from the outside and could not: `registerTool` is a non-writable property of a
native interface, so wrapping it throws, and an `unhandledrejection` listener loses to whatever
was registered at bootstrap. So we wrote our own. It is about 144 lines, and it keeps our runtime
dependency count at zero, which we did not plan but do not mind.

Making an agent's action feel like your own took longer than we expected. Early versions had a
tool call an API and then hope the page noticed. That is a second rendering path, and second
rendering paths drift. The fix was to hand tools the page's own refresh hooks and to make a
mutation refuse to resolve until the UI has caught up. By the time the sentence "done, I moved it"
reaches you, the map has already moved.

One thing broke that had nothing to do with us. Travala's travel MCP, which we used for hotel
search, moved to OAuth mid-challenge and now returns 401 on every call we used to make. Hotel
search is switched off in this build. The app hides the panel and both map tools say so in words
rather than flying the camera at an empty view, which felt better than pretending.

## Accomplishments that we're proud of

The one that matters is dull to state and was the entire point: WebMCP fixed the problem our users
actually reported.

Getting Reels in used to mean copying a URL, switching tabs, pasting, repeating, then hunting for
a separate button to start extraction. Now you say "save these reels" and paste four links in one
message, and the extraction starts itself. A finished trip used to be frozen solid, with no way to
change it at any layer. Now five tools edit it, each behind an approval card, each owner-checked
and flag-gated on the way to the database. Those two things were the complaint, and they are gone.

Underneath that, a few we are glad we got right. Nothing reaches the map unattributed, and a
contract test fails if our own copy ever promises a caption quote for a stop that has none, which
matters because the false version of that sentence reads better than the true one. The agent's
click and yours really are the same event rather than a parallel API that mirrors the UI. And our
tests check honesty as well as behaviour: they assert that the README's tool table matches the
registry, that the stated tool count is real, and that documented limitations are still
documented. When a claim stopped being true this week, a test went red.

## What we learned about WebMCP

None of us had touched WebMCP before this competition. It was announced, we read the spec, and we
started building. Four things surprised us.

It is a DOM API, not a server. We spent the first evening looking for the deployment story before
realising there is not one. Your tools ship with your JavaScript, and to the standard your origin
is just a static file host. Obvious in hindsight, and it reframes the whole design: the question
stops being "what should my API expose" and becomes "what does this page already have in scope".

Where you register a tool is a design decision, not a detail. Registering in the app shell versus
inside the trip page is the difference between a tool that always exists and one that appears when
there is something for it to act on. Tools that unregister on navigation are not cleanup, they are
how you stop an agent reaching for something that is not there.

The description field is the real API. It is the only place you can teach an agent when to call
something, and it is captured at registration, so it cannot carry anything dynamic. We rewrote
ours more times than we rewrote the code behind them.

And there is no way for the page to talk back. When a person clicks a pin, the agent has no idea.
That asymmetry shapes more of the design than we expected, and our answer is a tool whose whole
job is to be called when the user says "this" or "here".

## What's next for Astrail

Trips with more than one person in them. Nobody plans a holiday alone, and right now Astrail
assumes you do. A trip should hold several people who can all see it and all change it, each with
their own agent working the same map. That is the version of this challenge's premise we actually
want to build: not one person and one agent, but a group and theirs, editing one shared thing
without standing on each other. Everything here already points that way, because an agent edit and
a human edit are the same event, so a second person is not a new code path.

Memory that watches instead of only listening. Today Astrail remembers what you tell it. The trips
you accept say far more: which neighbourhoods you keep, how far you will really walk, whether you
fill a day or leave it open. Learning your style from the trips you kept, rather than from one
sentence you typed once, is the difference between an app that stores a preference and one that
knows you.

Flights, so it is the whole trip. An itinerary that begins when you land is half a plan. Search
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
