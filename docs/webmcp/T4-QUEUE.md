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
