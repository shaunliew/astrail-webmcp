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
2. **S2 — Confirm Render `SUPABASE_URL` = `ngfssihvukhxxqhcudix`.** 🔒 The frontend's `NEXT_PUBLIC_SUPABASE_URL` is set to `ngfssihvukhxxqhcudix.supabase.co` (from ZH's `.env.local`). If the backend's Supabase project differs, auth silently breaks — they must be the same project.
3. **S3 — `RESEND_API_KEY` (+ `RESEND_FROM_EMAIL`)** in Render if any deletion/notification email goes live (endpoints 503 without it). Per the SOP flag choreography.
4. **S4 — Auth email deliverability.** Confirm Supabase Auth sign-in / magic-link mail actually reaches beta users (custom SMTP / Resend vs the rate-limited default). Supabase = Shaun.
5. **S5 — ⚑1 Render `dev`→`main` repoint** — the 3-step sequence already in the RELEASE SOP. Listed for completeness.

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
