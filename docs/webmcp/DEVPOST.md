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
>
> 1,218 words. Zero em dashes. Every factual claim checked against the code, including the two
> that were softened: recall gating is a mechanism, not an absolute, and there are five Agents SDK
> agent files rather than four.

```markdown
## Inspiration

Instagram makes it effortless to save a Reel about somewhere you want to go, and then gives you nothing to do with it. The collection fills up with a hundred places across nine countries, and when the dates are booked the fastest path to an itinerary is still twenty browser tabs. That costs the saver rather than the researcher: someone who takes one or two trips a year and will never hand-map thirty Reels to coordinates and opening hours, so the folder stays shut and the trip gets planned off the first page of search results.

Astrail already did that conversion. Paste your Reel links and a multi-agent pipeline built on the OpenAI Agents SDK goes to work, pinned to `gpt-5.5-2026-04-23` with a `gpt-4o` fallback: separate agents for place extraction, restaurant grounding, itinerary narration and hotel name localisation, with a read-only summariser over the top that reports what the others decided and never overrides them. The late stages fan out concurrently and each one is allowed to fail on its own, so a weather API having a bad afternoon costs you a forecast rather than the trip. Anything without a verifiable location is dropped, the rest are grouped into days by geography, and the result lands on a 3D map in 60 to 180 seconds; the run we instrumented took 123.5.

Then we put it in front of people and got this back:

> "It's unclear how to navigate the website, where to click, how to choose the reels, how to start generating a trip."

That is not a copy problem, and we had already spent a sprint treating it as one. The tool was not hard to understand, it was hard to *operate*. We could keep redesigning the buttons, or remove the requirement to find them.

## What it does

Tell the agent to save some Reels and it saves them, starting extraction as it goes. Say "use the reels I just saved and plan me two days in Tokyo" and it reads your library, opens an approval card with the cost stated, starts the generation, narrates each stage, and hands you a routed map. Say "add Tokyo Disneyland to day 2" and it asks on the page, adds the stop, redraws the route, and rewrites the day summaries.

Every stop can be interrogated. Ask why stop 3 is on your trip and you get one of three answers: the verbatim caption quote from the Reel it came from, with a link to that Reel; Astrail's reasoning where it suggested the stop; or a plain note that you asked for it. Nothing sits on the map unattributed.

## The part that compounds

Astrail remembers how you travel, so the longer you use it the less you have to say. The memory engine predates this work by a month and is not claimed as challenge work. What we built is the path on which it actually gets used.

The backend searches memory only when the preferences field arrives empty, because what you typed for this trip should beat what you said three trips ago. The form takes a different route to the same idea: onboarding stores a travel style on your profile, the planning form pre-fills the preferences box with it, and a filled box counts as stating preferences this trip, so the search never runs. Ask an agent and the field stays empty, the condition that reaches instead for what Astrail learned from the trips you actually planned.

Consent keeps this a feature rather than a trick. With nothing stored, `plan_trip_from_reels` stops before it spends anything and asks how you like to travel, so the first trip is the one that teaches it. After that the approval card names what it remembered, before you approve the spend, and still offers a field to say otherwise. A remembered preference is a default, not a mandate. Astrail tries to remember what you state.

## Why it had to run in the page

Astrail's value is a live map, not a JSON blob. A backend MCP server could describe a trip. Only WebMCP can move the map the person is looking at.

Because `execute()` runs inside the page, a tool already holds the loaded trip, the signed-in session, and the same React state setters a click uses. The map tools receive those setters directly: ask for day 2 and the page's own `showDay` runs, so the camera flies and the day chip lights up as if you had clicked. There is no second rendering path to keep in sync, because there is no second path.

The agent inherits our security model rather than bringing its own: reads run in the page under the same row-level security, no access token crosses the tool boundary, and every edit to your trip stops for approval on the page rather than in chat.

## How we built it

Seventeen tools registered through `document.modelContext.registerTool()`, in two scopes: fourteen in the signed-in app shell, and three that register only while a trip map is mounted. Six work with no account, on a public sample trail. The write surface behind them is new too: the itinerary used to be immutable at every layer, with no endpoint, no frontend mutation and row-level security SELECT-only.

**Pin numbers, never UUIDs.** Tools address stops the way a person does: "move stop 7 to day 3". The page resolves that to a real row, so no identifier a human cannot read crosses the boundary, and map, itinerary and tools count from the same trail.

**A two-minute job behind a one-second tool call.** `plan_trip_from_reels` returns in about a second with a trip ID and a next step. The EventSource lives in a provider beside the map rather than inside `execute`, so one stream drives both the agent's narration and the on-screen wait.

**Reel captions are attacker-controlled text, defended at both ends.** In the browser, every tool whose output can carry a caption is annotated `untrustedContentHint`, machine-checked by a contract test. In the pipeline, the place extractor and the hotel localiser wrap their Agents SDK runs in `input_guardrail` tripwires that reject a caption trying to steer the run. One end stops the caption being read as instruction, the other stops it reaching a tool call.

The stack: Next.js 15, React 19 and Mapbox GL on Vercel; FastAPI on Render with server-sent events; Supabase for auth, Postgres and row-level security; mem0 for memory; Apify for Reel scraping.

## Challenges

**Making an agent's action indistinguishable from your own.** Early versions had a tool call an API and then hope the page caught up. The fix was to hand tools the page's own refresh hooks, and to make a mutation not resolve until the UI reflects it. By the time "done, I moved it" reaches you, the map has moved.

**Owning the registration.** Chrome's `use-webmcp-tool` hook never catches the promise `registerTool` returns, and since aborting the signal is *how* a tool unregisters, every navigation threw an unhandled `AbortError` across the app. It cannot be fixed from outside, because `registerTool` is non-writable, so we wrote our own.

## What we learned

Tests prove behaviour, not honesty. Nearly everything that went wrong last week was a sentence, not a function: a chip labelling every preferences row "Memory" whether memory had run or not, an activity rail calling a read-only lookup an irreversible change. A green suite says nothing about whether a label is true.

## What's next

Destination-scoped recall, so liking ramen does not follow you somewhere it makes no sense. Per-stage checkpointing, so a restart mid-generation resumes rather than starting over. And hotel search back on: it is off in this build and the page says so, because Travala's MCP moved to OAuth mid-challenge and now 401s every call.
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
