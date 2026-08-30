# End-to-end test — ChatGPT in-app browser

Everything is running locally: frontend `:3000`, backend `:8001`, edit tools enabled,
**Note the port.** `frontend/.env.local` points at `:8001`, but `backend/scripts/dev.sh` defaults to
`8000` — start it with `PORT=8001`, or nothing will connect. Edit tools also need
`WEBMCP_EDITS_ENABLED=true` in `backend/.env`; without it every edit returns 404.
The seeded account is not provisioned by anything in this repo — sign in with your own via OTP,
deletion sweep off.

## Setup

1. **ChatGPT desktop app**, model **GPT-5.6 Sol or Terra** — Luna has WebMCP disabled and shows
   zero tools with no error.
2. **Settings → Browser → Permissions → Enable site tools** → ON.
3. In the **built-in browser** (not Chrome), open `http://localhost:3000/sign-in/dev`
4. Sign in with a **seeded demo account**. Your own account will not work — real accounts are
   passwordless. This browser is a separate profile, so a Chrome login does not carry over.
5. You land on `/app`.

---

## 1 · Registration

Click the **Site tools arrow** in the address bar.

**Expect: 13 tools.** The on-page WebMCP chip must show the same number.

❌ Zero tools → wrong model, or site tools off. ❌ 6 tools → you are not signed in.

## 2 · Orientation

> What can I do here?

**Expect:** `get_app_state` describes *your real library* — reel count, verified places, trips —
and what to do next.

❌ Fail if it reports zero when you have reels, or names a tool that is not in the list.

## 3 · Ingest

> Save these reels: https://www.instagram.com/reel/DYGH3jFBZHz/ and https://www.instagram.com/reel/DXwcVVliX3B/

**Expect:** cards appear and move **Queued → Analyzing → places land**, with no refresh.

⚠ No approval card here, deliberately: `save_reels` is the one paid action that does not ask.

## 4 · The generation — the path never run through WebMCP

> Plan me a Tokyo trip from these Instagram Reels: https://www.instagram.com/reel/DYGH3jFBZHz/ https://www.instagram.com/reel/DYM_I5IvLSv/ https://www.instagram.com/reel/DXwcVVliX3B/ Start date 2026-09-09, end date 2026-09-14. Mid-range budget, walkable days.

**Expect, in order:**
1. An **approval card on the page, before anything is spent**, showing your prompt verbatim.
2. You approve → the wait screen **takes over**, narrating real stages with a running clock.
3. 60–180s. Let it finish; do not retry.
4. Sunrise fires, and it opens the finished map.

❌ **Fail if anything is spent before you approve.** That is the gate that protects the trial.

Dates are 10 days out on purpose — inside Open-Meteo's ~16-day window, so weather actually returns.

## 5 · On the trip

Check the tool count again. **Expect 16.**

> Show me day 2 on the map

**Expect:** camera flies, day chip changes.

> Why is stop 1 on this trip?

**Expect:** the verbatim Instagram caption quote plus a `reel:` link to the Reel it came from.

⚠ Do **not** ask for 3D. `set_map_mode` takes `route` or `hub` only; asking for 3D correctly
returns an error. No tool can extrude buildings — that layer is minzoom 15, the deepest tool camera
is zoom 14.

## 6 · Edit, then replan — the Osaka Castle bug

> Move stop 3 to day 1

**Expect:** the route redraws, and the reply tells the agent the summaries are now stale and names
`replan_trip`.

> Now replan the trip

**Expect: the day descriptions and plan text update to match the new order.**

This is the bug you reported — an edited trip still describing the old itinerary. It is the entire
reason `replan_trip` exists, and it has never been run live.

## 7 · The free path, signed out

Open a **private/incognito** tab in the same browser → `http://localhost:3000/app/trip/demo`

**Expect 6 tools**, not 16. Then:

> Why is stop 4 there?

**Expect:** Ichiran Shibuya, a reasoning line, and `research: https://ichiran.com/` — with **no
`reel:` line**. A Reel there would be the `ec06e6c` bug back.

---

## If something fails

Most failures here are environment, not code: wrong model, site tools off, not signed in, or the
backend down. Check those four first.

Tell me the step number and what you saw — I have the backend log and can tell you whether the
request even arrived.
