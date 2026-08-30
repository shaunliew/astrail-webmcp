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

⚠ No approval card here, deliberately: `save_reels` is the one action that spends with no card in
front of it. Save one of these twice to see the other half — a reel whose places are already
extracted comes back "already in your library" and is **not** re-extracted, while one that was saved
but never finished extraction is queued again.

## 4 · The generation — run through WebMCP on 30 Aug, never on a deployed URL

> Plan me a Tokyo trip from these Instagram Reels: https://www.instagram.com/reel/DYGH3jFBZHz/ https://www.instagram.com/reel/DYM_I5IvLSv/ https://www.instagram.com/reel/DXwcVVliX3B/ Start date 2026-09-09, end date 2026-09-14. Mid-range budget, walkable days.

**Expect, in order:**
1. An **approval card on the page, before anything is spent**, showing your prompt verbatim.
2. You approve → the wait screen **takes over**, narrating real stages with a running clock.
3. 60–180s. Let it finish; do not retry.
4. Sunrise fires, and it opens the finished map.

❌ **Fail if anything is spent before you approve.** That is the gate that protects the trial.

Dates are 10 days out on purpose — inside Open-Meteo's ~16-day window, so weather actually returns.

This whole arc ran through an agent on 30 Aug and completed in a measured 123.5s, of which
restaurant enrichment was roughly 94%. It ran against a backend on `localhost`, which is the only
kind of run anything in this repository has had — there is no deployment yet, so nothing here has
been exercised on a URL a judge would open.

## 5 · On the trip

Check the tool count again. **Expect 16.**

> Show me day 2 on the map

**Expect:** camera flies, day chip changes.

> Why is stop 1 on this trip?

**Expect:** the verbatim Instagram caption quote plus a `reel:` link to the Reel it came from.

⚠ Do **not** ask for 3D. `set_map_mode` takes `route` or `hub` only; asking for 3D correctly
returns an error. No tool can extrude buildings — that layer is minzoom 15, the deepest tool camera
is zoom 14.

## 6 · Edit, and watch the prose catch up on its own — the Osaka Castle bug

> Move stop 3 to day 1

**Expect, in order:**
1. An **approval card** naming the move *and* saying Astrail will rewrite the day summaries. A move
   is cheap; the rewrite it triggers is not, which is why it asks.
2. You approve → the route redraws and the stop numbers shift.
3. The reply says the summaries are stale **and already being rewritten**
   (`summaries_rewriting: true`), and tells the agent **not** to call `replan_trip`.
4. ~30s later the activity rail turns `REWRITE` → `REWROTE`, and the day descriptions match the new
   order.

❌ **Fail if the agent calls `replan_trip` anyway** — that buys a second narration for work already
running. ❌ Fail if the prose never catches up.

Do not type "now replan the trip" here. That was the old flow: `move_place` used to hand the agent
`next_tool: replan_trip`, and it still does for the one case that needs it — prose stale with no
rewrite running. Ask for a replan only when you want the wording refreshed for its own sake.

This is the bug you reported — an edited trip still describing the old itinerary. It is the entire
reason `replan_trip` exists. It has been run live through the agent (30 Aug, after an add and after
a remove, checked in the database), against a **local** backend like everything else here.

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
