# Testing in ChatGPT's in-app browser

Run against the local dev server. Written so each step has a **pass/fail you can see**, not "looks
fine".

## Before you start — four things that silently produce an empty tool list

1. **GPT-5.6 Sol or Terra.** Luna has WebMCP disabled and shows no tools, with no error.
2. **Settings → Browser → Permissions → Enable site tools** must be ON.
3. **Not an Enterprise or Edu workspace** — site tools are unavailable there.
4. Open the URL in the **built-in** browser, not by copying it to Chrome.

Then look for the **Site tools arrow** in the address bar: grey = available, blue = in use.

---

## Part 1 — the free path, no account, no backend

**URL:** `http://localhost:3000/app/trip/demo`

This is the path a judge takes. It needs no sign-in and spends nothing.

### 1.1 Registration

| Check | Pass |
|---|---|
| Site tools arrow appears | grey arrow in the address bar |
| Tool count | **6** |
| The six | `get_app_state`, `get_itinerary`, `get_place_evidence`, `show_on_map`, `set_map_mode`, `get_map_view` |
| On-page WebMCP chip | reads **"WebMCP active · 6 tools"** — must agree with the address bar |

❌ **Fail if you see 16.** That means the signed-out gate did not apply and eleven tools that need a
JWT are being advertised to someone with no account.

### 1.2 "What can I do here?"

Expect `get_app_state` to say, in substance:
- you are on the **public sample trail**
- **no account** — and that it will say nothing about your own reels or trips
- **five** next steps, each with its tool
- **blocked**: saving Reels, planning and editing need an account

❌ Fail if it names your real library, or recommends a tool not in the six.
⚠ It lists **five**, not six — it leaves itself off its own list. That is correct.

### 1.3 The evidence contrast — the most important check

> **Why is stop 1 on this trip?**

Expect **Akasaka Station**, the verbatim quote *"HARRY POTTER TRAIN STATION IN TOKYO!"*, and a
`reel:` line pointing at `instagram.com/reel/DYGH3jFBZHz/`.

> **And why is stop 4 there?**

Expect **Ichiran Shibuya**, confidence 0.80, a reasoning line, and `research: https://ichiran.com/`
with **no `reel:` line and no Instagram URL**.

❌ **Fail if stop 4 shows a `reel:` line.** That is the bug fixed in `ec06e6c` — the tool citing a
research page as though it were the source Reel.

### 1.4 The map

> **Show me day 2 on the map**

Expect the camera to fly and the day chip to change.

> **Switch to the hotel hub view**

Expect the hotel layer.

⚠ **Do not ask for 3D.** `set_map_mode` takes `route` or `hub` only. Asking for 3D returns
`mode must be "route" or "hub".` — that is correct behaviour, not a bug. No tool can extrude
buildings: that layer is minzoom 15 and the deepest tool camera is zoom 14.

> **What am I looking at?**

`get_map_view` returns the camera and the trip's day/stop totals, and says plainly it cannot see
which stop is selected. ❌ Fail if it claims to know your selection.

---

## Part 2 — signed in (needs the backend)

The backend must be running on **:8001** (that is what `frontend/.env.local` points at). Ask me to
start it — I did not start it unattended because a local backend against the shared Supabase
project picks up and re-runs other people's stuck jobs, which spends real Apify and OpenAI credit.

### 2.1 Counts

| Where | Expect |
|---|---|
| Anywhere in `/app` | **13** |
| With a trip open | **16** |
| `/app/trip/demo` signed in | **16**, and the label says it is an example trip, not one of yours |

### 2.2 Worth pointing at specifically

- **`get_app_state` on an empty account** — should lead with the agent, not describe buttons.
- **`save_reels`** — proven live before; the card should show Queued → Analyzing without a refresh.
  Note it raises **no approval card**: it is the one paid action that does not ask.
- **The edit tools** need `WEBMCP_EDITS_ENABLED=true` on the backend. Without it they return 404 and
  the agent says *"That trip or stop was not found — or trip editing is not enabled on this
  deployment."* That wording is deliberate; a bare "not found" read as a broken product.
- **`plan_trip_from_reels`** — the one path never run end to end. It spends real credit. The
  approval card must appear **before** anything is spent, and must show your prompt verbatim.

---

## What a failure here means

Most of this is pinned by tests, so a failure is more likely to be an **environment** problem than
a regression — wrong model, site tools off, backend down, or the flag unset. Check those four
before assuming the code broke.

The genuinely unverified thing is the ChatGPT surface itself: registration mechanics were last
confirmed there on 29 Aug, and `get_app_state` has been rewritten since.
