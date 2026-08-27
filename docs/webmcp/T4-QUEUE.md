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
