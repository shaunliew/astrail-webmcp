# T4 queue — needs a human

Appended as unattended work produces things only a person can judge.
Worked at the evening review; the big passes wait for the weekend.

**Legend:** 🔴 blocks the submission · 🟡 quality · 🟢 nice to confirm

---

## Day 0 — do these first, they cost 20 minutes and no code

- 🔴 Open **production Astrail** in the ChatGPT desktop app's built-in browser.
  Does it load? Does the session behave? Does `document.modelContext` exist in the console?
- 🔴 **Cross-tab test.** Open 3 public Instagram Reel tabs in that browser and ask:
  *"What are the URLs of the Instagram reels open in my other tabs?"*
  → works: lead the demo with cross-tab import. → fails: demo says "save these reels: <urls>".
  Either way **no code changes** — `save_reels({urls})` is identical.

## Day 1 output

- 🔴 Once the repo is public: confirm the **licence badge renders in GitHub's About section**.
      A modified LICENSE file fails detection and the badge never appears.

## After batch 1–2 (built overnight, needs your eyes)

- 🔴 **The two day-0 checks above.** Nothing downstream is safe to assume until they are done.
- 🔴 **Do the tools actually register?** Start the frontend dev server (the `dev` script in
      `frontend/package.json` — the repo hook requires it to run inside tmux), then open
      `localhost:3000/app` in Chrome 149+ with `chrome://flags/#enable-webmcp-testing` **and**
      `chrome://flags/#devtools-webmcp-support`. Expect the brass chip bottom-right to read
      **"WebMCP active · 2 tools"**, and DevTools → Application → WebMCP to list `get_app_state`
      and `list_trips`. This is the first real proof — everything so far is unit-tested only.
- 🔴 **Execute one tool by hand** in that DevTools panel. Check the output reads well *as prose an
      agent would say back to a user*, not merely that it returns.
- 🟡 **Judge the tool descriptions.** Tests prove they are ≤500 chars; only a human can tell whether
      they actually steer the agent. `get_app_state`'s description is the one that matters most.
- 🟡 **`WebMcpStatus` placement** is `fixed bottom-4 right-4`. Check it does not collide with the trip
      workspace's bottom-centre reopen tab or the layer switch.
- 🟡 **`get_app_state` reports `savedReels: 0` / `verifiedPlaces: 0`** — it is wired to trips only.
      Hooking `listSavedReelCards()` needs a signed-in session, so it is a follow-up, not overnight work.
- 🟢 Read `docs/webmcp/SUBMISSION.md` — the text judges may score **without opening the app**.
- 🟢 Read `docs/webmcp/WHATS-NEW.md` — eligibility item; confirm the pre-existing/new split is honest.

## After the morning batch — 12 tools, needs your eyes

- 🔴 **Re-check the trip page in ChatGPT.** The chip should now read **5 tools** on `/app` and
      **8 on a trip page** (3 map tools register there). The infinite-loop fix is verified in
      headless Chromium but not yet in ChatGPT's browser.
- 🔴 **Try the flow that motivated the global-tools change**, from `/app`, without opening a trip:
      *"What's on day 2 of one of my Kyoto trips?"* → expect `list_trips` then `get_itinerary`.
- 🟡 **The basemap looks like full daylight** in `evidence/01-trip-map.png`, not the Night &
      Daybreak aesthetic. Could be the dawn `lightPreset` behaving as designed, or a regression
      from the map work. Only you can tell.
- 🟡 **Day-route colours are hard to distinguish at overview zoom** (see `01-trip-map.png`).
      Legible up close; may need more contrast when zoomed out.
- 🟡 **Marker chips hide below zoom 11** — by design, but check the threshold feels right in Tokyo.
- 🟡 Codex's own list: chip density on mobile, a long multiline caption in a popup, a >6-day trip
      where the colour palette cycles, and a city with no `composite/building` data.
- 🟢 `move_place` / `remove_place` are **unit-tested only** — no live writes, as you asked.
      `WEBMCP_EDITS_ENABLED` is still false and no backend is running locally.
- 🟢 `plan_trip_from_reels` has **never been run for real** — it costs Apify + OpenAI credit and
      burns the trial. Needs you present.

## After the completion pass — 13 tools

- 🔴 **Chip should read 10 tools on `/app`, 13 on a trip page.** Verified in headless Chromium with
      a shim; not yet in ChatGPT's own browser.
- 🔴 **Try, from `/app` without opening a trip:** *"What's on day 2 of one of my Kyoto trips?"*
      Then the same question **while on a trip page** — it should use that trip, not ask which.
- 🟡 **Watch for a slow WebMCP injection in ChatGPT.** The hook stops looking 10s after mount. If
      the chip says "unavailable" on a slow load but works after a refresh, that is the cause.
- 🟡 **Judge the Agent Rail's timing** — entries fade after 8s, max 5 shown. Feels right in tests;
      only you can say whether it reads as calm or as noise during a real conversation.
- 🟡 **The example-prompts panel and the rail share the bottom-right corner** with the WebMCP chip.
      Check they do not stack badly on a small window.
- 🟢 `README.md` and the landing page are rewritten for judges. **`frontend/app/page.tsx` has a
      clearly marked `TODO` for demo credentials** — that must be filled before submitting.

## After the lunchtime fixes

- ✅ **Both red checks passed** — global tools from `/app`, and the open trip used on a trip page.
- ✅ Panel closes (chip toggles, plus an explicit ✕). Verified at 375 / 768 / 1440.
- 🟡 **Re-check the dock in ChatGPT's browser** at the window size you actually use. The geometry
      is verified in headless Chromium; ChatGPT's browser chrome may leave less height.
- 🟡 **The prompts panel now hides while the tool list is open.** Check that reads as intentional
      rather than as the panel disappearing on you.
- 🟡 Still open from this morning: the **daylight basemap** in `evidence/01-trip-map.png`, and
      whether the Agent Rail's 8s fade reads as calm or as noise in a real conversation.
- 🔴 Still open: the **demo-credentials `TODO`** in `frontend/app/page.tsx` blocks submission.

## UX pass (afternoon, 27 Aug) — needs your eyes

- 🟢 **Fixed and verified in a browser:** the map never framed the trip on mobile (globe over the
      Indian Ocean); the status chip covered the day/leg counts; pasting several Reel links did
      nothing; the home screen had no "what next"; the plan sheet promised skippable dates it then
      refused. Before/after in `docs/webmcp/evidence/ux-before/` and `ux-after/`.
- 🟡 **Judge the new home CTA copy** — "Plan a trip from your N saved reels". It is the first
      thing that tells someone what to do after saving, so the wording matters more than usual.
- 🟡 **Try pasting a block of Reel links** into the capture box. It should fill a row per link,
      up to 5, without touching "+ Add another link".
- 🟡 **"Use a 3-day draft"** on the plan sheet fills the picker with tomorrow + 2 days. Check the
      default range feels sane, and that the picker visibly shows what it chose.
- 🔴 **Still unaddressed, and the biggest remaining one:** the ~60-180s organize wait shows only
      decorative cycling words ("Stargazing…", "Connecting the dots…") that are explicitly
      unrelated to backend progress. The REAL status is rendered `sr-only`, so a sighted user
      cannot tell working from stuck. Everything needed is already streaming — this is a
      presentation fix, not a data one.
- 🔴 **Dead end:** a tray of never-organized reels shows a disabled "Create trail" with no path
      forward. The user has to independently know to go back to the library and select.
- 🟡 **Vocabulary is inconsistent on one screen**: the empty state says "No trails yet" while the
      section header below it says "Your trays", and neither is ever defined. "Your grounded
      places" is geo jargon a traveller will not parse.
- 🟡 **Re-pasting the same link always says "Saved to your library"** — the RPC upserts, so a
      duplicate is indistinguishable from a new save.

## Map + suggestions pass (evening, 27 Aug) — needs your eyes

Everything below is verified in a browser and by test; what it needs from you is judgement, and
one live generation. Ordered by what breaks the demo if it is wrong.

### 🔴 Do this one first — it is the only unproven path

- **Run ONE fresh trip generation.** Nothing else exercises the new restaurant details search
  (`genagents/restaurant_details.py`), because it only runs during generation. Costs one hosted
  web search per DAY on top of the existing per-day labelling call. Set
  `ASTRAIL_RESTAURANT_DETAILS=0` to skip it if you would rather not spend.
  - Watch stderr for `[restaurant-details] pois=N enriched=M`.
  - **`enriched=0` is a PASS, not a failure.** Small Japanese venues publish nothing; Mapbox's
    own metadata was empty for 20 of 20 restaurants near the Osaka trip. The design keeps
    silence over a guess.
  - If M > 0, open an eat pin: hours should read as one line, and "More about this place ↗"
    should go to the page those hours came from — the same source, never a different site.

### 🟡 Judge by eye

- **Teardrop pins.** Reel-sourced stops carry the Reel's cover in a brass ring; everything else
  gets one placeholder disc. Is the hierarchy right — do the numbered stops still dominate the
  eat/hotel pins beside them?
- **Eat pins at 30px.** Big enough now? They were 22px and before that an 8px dot.
- **The eat card** — cuisine, street address, why Astrail picked it, "Near <stop>". No image and
  no hours unless the search found them; both are absent by design, not missing.
- **Hotel card** (needs a trip that HAS hotels — the Osaka one has none): star class and guest
  score on separate lines, nightly + total, cancellation, and the "Astrail does not book" line.

### 🟢 Verified, but worth one glance in ChatGPT's browser specifically

- Clicking a name under "Where to eat" flies the map there and opens its card.
- Tapping a pin on a phone scrolls the matching itinerary card into view (the popup cannot be
  seen on mobile at all — it is trapped below the sheet's stacking context).
- A stop from another day selects correctly: the day switches with it.
- Popups fit on a 1280x720 laptop, including both buttons.

### ⚠ Known gaps, stated rather than discovered later

- **Hotels: the Osaka trip has zero.** The stage ran and emitted no warning, so "searched and
  found nothing" and "failed silently" are indistinguishable from outside. Weather emits a
  warning in the same situation; hotels does not. Small backend fix, not yet done.
- **Opening hours are not obtainable for most Japanese venues** from any provider we have.
  Measured, not assumed: Mapbox returns `metadata: {}` for 20/20 nearby restaurants, and
  unconstrained it matched an Osaka sushi bar to a Brooklyn one 11,111 km away.
- **`preference_match_json` is `{}` on every row in both tables.** Nothing writes it. The
  "matches your taste" rows were removed rather than left to render empty in front of a judge.
