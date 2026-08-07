# Frontend / Vercel pre-launch — deploy handoff (2026-08-07)

> **Receiving owner: Shaun.** ZH's frontend/Vercel pre-launch prep is done — the 6 production
> `NEXT_PUBLIC_*` env vars are set (the project had **zero**, which would have shipped a broken launch
> build). One finding changes the run-sheet: **the frontend does NOT auto-deploy on merge** — Vercel
> is on the Hobby plan, which can't git-connect the private org repo, so the frontend goes live only
> via a manual `vercel --prod` (ZH). **If you do nothing:** the backend still auto-deploys via Render,
> but astrail.xyz's frontend stays frozen at the 45-day-old build until ZH runs that manual deploy.
> Also flagged below: two EMDEE launch docs are getting wiped.

## State at a glance

| Thing | State |
|---|---|
| Frontend code | on `dev` @ `b47cf73` (merge zh→dev); working tree clean |
| Vercel Production env vars | ✅ **6 set 2026-08-07** — `NEXT_PUBLIC_SITE_URL`, `_BACKEND_URL`, `_SUPABASE_URL`, `_SUPABASE_ANON_KEY`, `_MAPBOX_PUBLIC_TOKEN`, `_MOCK_AUTH=false` |
| Vercel git connection | ❌ **not connected** — Hobby blocks private org repos → frontend deploys are **manual `vercel --prod`** |
| Vercel "Production Branch" | n/a — the setting doesn't exist without a git connection |
| Frontend today | current prod = 45-day-old build; a fresh one is one `cd frontend && vercel --prod` away |
| Backend | Render auto-deploys (git-connected on Render) — unaffected by the above |
| User-visible | nothing new — the in-design landing is on `dev`, not published |

## Your lane — what blocks the gate (Shaun)

1. **S1 — `ALLOWED_ORIGINS` must include the prod origins.** Add `https://astrail.xyz` + `https://app.astrail.xyz` to the backend env, or every frontend→backend call (trip generation) CORS-fails. A Render env PUT doesn't redeploy — verify the process restarted with the value.

   ✅ **DONE 2026-08-07 (Shaun), verified live.** You were right, and it was worse than stated: a CORS preflight against the deployed backend showed the allowlist **permitted a host that does not exist and blocked one that does** — `www.astrail.xyz` has **no DNS record**, while `app.astrail.xyz` was serving the byte-identical Vercel build and was **rejected**. Fixed in `5c73dbc` in BOTH `render.yaml` (literal value — a Blueprint sync re-asserts it, so a dashboard-only edit is silently reverted) and `main.py`'s fallback, which had the same omission. Post-deploy preflight: `astrail.xyz` ✅ · `www.astrail.xyz` ✅ · `app.astrail.xyz` ✅ · `evil.example.com` blocked · `app.astrail.xyz.evil.com` blocked (matching is exact, not prefix).
2. **S2 — Confirm Render `SUPABASE_URL` = `ngfssihvukhxxqhcudix`.** 🔒 The frontend's `NEXT_PUBLIC_SUPABASE_URL` is set to `ngfssihvukhxxqhcudix.supabase.co` (from ZH's `.env.local`). If the backend's Supabase project differs, auth silently breaks — they must be the same project.

   ✅ **CONFIRMED 2026-08-07 (Shaun)** in the Render dashboard — they match. (Note for future checks: the Render API/CLI does **not** expose env vars, and `supabase/.temp/project-ref` only reflects the local CLI link, not Render's config. This has to be read in the dashboard.)
3. **S3 — `RESEND_API_KEY` (+ `RESEND_FROM_EMAIL`)** in Render if any deletion/notification email goes live (endpoints 503 without it). Per the SOP flag choreography.

   ⏳ **DELIBERATELY NOT SET — still held.** It is switch 1 of the deletion choreography and stays shut until your F1/F2/F3 + 2 regression tests are signed off. Two things changed on 2026-08-07 though: (a) the **value** was wrong everywhere and is now corrected — it is `Astrail <no-reply@astrail.xyz>`, the ROOT domain, **not** `send.astrail.xyz`, which the live API rejects with `403 "domain is not verified"` (see the RELEASE SOP note); (b) the pair is now **proven end-to-end** (4 delivered emails), so switch 1 is a paste, not a debugging session. Verify any change with `cd backend && uv run python -m scripts.preflight_resend --to <inbox>`.
4. **S4 — Auth email deliverability.** Confirm Supabase Auth sign-in / magic-link mail actually reaches beta users (custom SMTP / Resend vs the rate-limited default). Supabase = Shaun.

   ✅ **VERIFIED 2026-08-07 (Shaun) — better than assumed.** Custom SMTP is **already configured** and is Resend on the verified root domain; it is NOT the rate-limited Supabase default. A real `POST /auth/v1/otp` delivered to Gmail **Inbox, not spam**, with headers `from: Astrail <no-reply@astrail.xyz>` · `mailed-by: send.astrail.xyz` (the Return-Path/bounce channel) · `Signed by: astrail.xyz` (DKIM aligned with the From domain → DMARC passes). The email carries a **6-digit code**, which matches the UI's 6-box input and `verifyOtp({ type: 'email' })` at `sign-in/page.tsx:127`. Supabase **Auth → Rate Limits** raised the same day. ⚠ One defect found — **yours**, see the section below.
5. **S5 — ⚑1 Render `dev`→`main` repoint** — the 3-step sequence already in the RELEASE SOP. Listed for completeness.

   ❌ **NOT DONE.** `origin/main..origin/dev` is 800+ commits and `render.yaml` still pins `branch: dev` on both services — so **`dev` is currently what production runs**, and every push to `dev` is a production deploy. Unchanged from the SOP; flagged because it makes the push semantics non-obvious.

## ⚠ Back to you (ZH) — the sign-in copy names a domain that cannot send mail

**`frontend/app/sign-in/page.tsx:373`** tells every user:

> Nothing in your inbox? Check spam. The sender is `no-reply@astrail.app`.

**The real sender is `no-reply@astrail.xyz`** (proven above, from live headers). `astrail.app` is a **parked domain**: nameservers `launch1/launch2.spaceship.net`, **no MX record at all**, HTTPS times out. No mail can ever originate from it.

**Why it matters more than a typo.** This is the fallback copy shown precisely when a user cannot find their code — the moment it is supposed to rescue them. Following it sends them searching for a domain that has never sent them anything, at the front door of an invite-only beta. It is a one-word fix (`app` → `xyz`) with an outsized failure mode.

Not changed by Shaun: it is frontend, your surface, and the owner split says neither of us edits the other's silently. Suggested:

```tsx
<span className="whitespace-nowrap font-mono text-[color:var(--text)]">no-reply@astrail.xyz</span>.
```

Worth a grep for other user-facing `astrail.app` strings while you are in there — `sign-in/dev/DevSignInForm.tsx:12` seeds `aster@astrail.app` (dev-only, harmless) and a couple of story components render `astrail.app` as display text, which may or may not be intended branding.

## Verification performed (ZH, 2026-08-07)

- `vercel env ls production` → the 6 vars present (stored Sensitive/encrypted). Set via `vercel env add … production`; Supabase/Mapbox values piped from `.env.local` (never echoed to chat).
- Backend health: `curl https://astrail-backend.onrender.com/health` → **200** (root `/` → 404, expected).
- **Coverage boundary — NOT verified:** no production deploy was run (held for SOP sign-off), so the env vars are **set but not yet exercised in a build**. Frontend↔backend (trip generate) is **untested** and will CORS-fail until **S1**. Because the vars are "Sensitive," a local `vercel build` can't read them — only a Vercel deploy exercises them.

## Deploy order (frontend-specific)

Golden order unchanged (DB → backend → frontend → flags). Only step 5's *mechanism* changes:
- **The frontend step is manual.** Once `main` is the source, ZH runs `cd frontend && vercel --prod` (deploys local `frontend/` with the Production env vars). It is **not** triggered by the merge.
- ⚠ So the run-sheet's "merge `dev`→`main` IS the public launch" holds for the **backend** only. The **frontend** public launch is the separate `vercel --prod`, run **after** the backend is healthy.
- `NEXT_PUBLIC_*` are build-time; the deploy bakes them.

## Rollback

- Frontend: Vercel → Deployments → previous prod build → **Promote to Production** (instant). Unchanged from SOP.

## Deferred — deliberately NOT fixed here

- **Vercel git auto-deploy + PR previews** — needs **Vercel Pro** ($20/mo) to connect the private org repo. Launching on the free manual-deploy path. Trigger: post-launch, when the team wants auto-deploy + preview URLs (also solves the dev-QA-before-prod loop we've been fighting).
- **Landing OG/social image** (ZH) — real `og:image` + Twitter card so shared astrail.xyz links preview. Trigger: before wide link-sharing.
- **Full staging** (separate Render + Supabase + `staging.astrail.xyz`) — post-launch, SOP "Option B".

## References

- ⚠ **EMDEE data loss (needs attention):** `astrail/INFRASTRUCTURE.md` was restored 2026-08-06 and **wiped again** by 2026-08-07; `astrail/LAUNCH-PRE-CHECKLIST.md` is **empty** too. Something is blanking shared-vault docs. INFRASTRUCTURE content is recoverable (ZH holds it); **LAUNCH-PRE-CHECKLIST must be restored from version history by whoever wrote it (Shaun?)** — a blank launch checklist is a launch risk.
- `docs/CONNECTION-CONTRACT.md` — FE↔BE contract.
- EMDEE `astrail/RELEASE-SOP.md` — a guarded finding note pointing here was appended to its run-sheet 2026-08-07.
