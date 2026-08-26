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
