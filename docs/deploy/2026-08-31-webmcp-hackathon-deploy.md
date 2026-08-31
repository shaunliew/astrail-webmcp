# WebMCP hackathon deploy — run-sheet

> Written 2026-08-31 for the OpenAI WebMCP Challenge submission. Every value below was read out
> of the code, not remembered. Line references are to `feat/webmcp` at the time of writing.
>
> **Submission repo:** `shaunliew/astrail-webmcp` (public, standalone, MIT detected, default `main`).
> **Deadline:** Thu 4 Sep 04:00 GMT+8.

## The one ordering rule that matters

**Set every `NEXT_PUBLIC_*` in Vercel BEFORE the first build.** `frontend/next.config.ts` builds
the CSP `connect-src` from `backendUrl` and `supabaseUrl` **at build time** (line ~26). Get them
wrong or set them late and the browser silently blocks every call to your backend — the symptom
is that tools appear, execute, and fail with nothing useful in the console. Rebuild after fixing;
changing the env var alone does not change the shipped header.

---

## 1 · Render — backend

**Do NOT reuse `render.yaml`.** It names `astrail-backend` on `MalaysiaKaki/astrail@main` — the
production service. Render's own docs warn against managing one service from two Blueprints, and
a copy of this file would do exactly that. Create `render.webmcp.yaml` with a **different service
name** (`astrail-webmcp-api`) and set Blueprint Path to it.

Two things to carry over from `render.yaml` deliberately:
- `region: singapore`, `plan: starter` — Free spins down after 15 min and takes ~60 s to wake. A
  judge on a cold link waits a minute before the first pixel, then 60–180 s for a generation.
- `healthCheckPath: /health` — the dumb liveness probe that never touches the DB, so a DB blip
  cannot fail a deploy.

**Do NOT include `astrail-telegram-ingest`.** It is out of scope, and a second worker long-polling
the same bot against the shared database would double-process real reel submissions.

### Required env (all five, or the app refuses to boot)

`backend/config_validation.py` fails closed and names **every** missing var at once, so you get
one list rather than a fix-one-per-restart loop. Blank and whitespace-only count as missing.

| Var | Note |
|---|---|
| `OPENAI_API_KEY` | |
| `APIFY_TOKEN` | |
| `SUPABASE_URL` | doubles as the JWKS source |
| `SUPABASE_SERVICE_ROLE_KEY` | |
| `MAPBOX_SECRET_TOKEN` | needed by grounding AND by `add_place`'s geocode |

### Also set

| Var | Value | Why |
|---|---|---|
| `ALLOWED_ORIGINS` | the Vercel origin | Unset falls back to the prod astrail.xyz origins. Fails as a **browser CORS block**, not a boot error — so it looks like every tool call is broken |
| `WEBMCP_EDITS_ENABLED` | `true` | Defaults **false** (`main.py:117`), which makes the edit endpoints 404. Tools still register either way, so the symptom is tools that exist and refuse |
| `DAILY_TRIP_QUOTA` | raise from `5` | `rate_limit.py:38`, read at import — **needs a restart, not just a var change** |

### 🚨 Leave `RUN_DELETION_SWEEP` UNSET

`main.py:176`. This deployment shares the **production database**. Set it and a second backend
sweeps real user accounts for deletion every 120 s. Verify it is unset before the first deploy,
not after.

> Note the sweep that is *not* flag-gated: `_reap_loop` redispatches stuck jobs unconditionally in
> every process. A second backend on the shared DB can pick up and re-run someone else's job,
> spending real Apify and OpenAI credit. Nothing to configure — just do not leave spare backends
> idling against the shared project.

---

## 2 · Vercel — frontend

New project on Shaun's own account (production Vercel lives under Zhi Hao's). Set **all** of these
before the first build:

| Var | Note |
|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | the Render URL. **Feeds the CSP** |
| `NEXT_PUBLIC_SUPABASE_URL` | **Feeds the CSP** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | |
| `NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN` | `pk.` token, URL-restricted to the new domain |
| `NEXT_PUBLIC_SITE_URL` | the Vercel origin |
| `NEXT_PUBLIC_MOCK_AUTH` | **must be `false`/unset.** `true` short-circuits every call to a mock and never reaches the backend |

### 🚨 Do NOT set `NEXT_PUBLIC_DEMO_EMAIL` / `NEXT_PUBLIC_DEMO_PASSWORD`

**Corrected 2026-08-31 — the first draft of this file listed them as required. That was wrong.**
`NEXT_PUBLIC_*` is inlined into the **client bundle** at build time, so a credential set there is
readable out of the shipped JavaScript whether or not any component prints it. A working login in
a public bundle is an open door to an account that spends real Apify and OpenAI credit.

Judge credentials go in the **Devpost submission form's testing-instructions field**, which only
Devpost and the judges can see. They must not appear in this repo, in Vercel env, or in the
landing page.

`NEXT_PUBLIC_DELETION_ENABLED` stays off — account deletion is a three-switch cross-owner
sequence and is not part of this submission.

---

## 3 · The judge account (Supabase)

A trigger (`on_auth_user_inserted`) creates `public.users` automatically. **Nothing creates
`traveler_profiles`**, and `middleware.ts` treats a missing profile row as not-onboarded — so a
demo account signs in successfully and then bounces to `/app/onboarding`. That is the failure that
looks like bad credentials and is not.

1. Dashboard → Authentication → Users → Add user, **tick Auto Confirm User** (the sign-in code has
   a specific error for an unconfirmed email).
2. Then:

```sql
update public.users set plan = 'beta' where email = '<judge email>';

insert into public.traveler_profiles (id, onboarding_completed)
select id, true from public.users where email = '<judge email>'
on conflict (id) do update set onboarding_completed = true;
```

`plan` defaults to `'trial'` and `TRIAL_LIFETIME_LIMIT` is **1** (`rate_limit.py:39`) — a judge on
trial burns their one lifetime trip and gets a 403 on the second.

---

## 4 · Verify, in this order

1. `GET /health` → `{"status":"ok"}` · `GET /readiness` → `ready:true`
2. Sign in at `/sign-in` with the demo credentials → land on the trip list, **not** the onboarding
   wizard
3. Open a trip and confirm a tool call reaches the backend — a CSP block appears here, and only
   here
4. `/app/trip/demo` **signed out** in a fresh browser → six tools, no bounce to `/sign-in`
5. One real generation, attended — it spends real credit, so do it once and watch it

## Not done, and deliberately

- **Chrome origin-trial token** for the new hostname. Not needed for judging: ChatGPT's built-in
  browser has WebMCP natively. Only add it if you want Chrome 149 testing without the flag.
- **Explicit `REVOKE`s** for the RLS defence-in-depth layer (see the CI entry in `RUNLOG.md`) —
  a production migration, not a deadline-week change.
