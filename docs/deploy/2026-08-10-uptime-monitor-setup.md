# Uptime monitor setup — Astrail production (manual)

> **Owner:** Zhi Hao · **Account signup and external configuration:** manual
> **Status:** instructions drafted; monitors and alert delivery are **UNVERIFIED / NOT CREATED**.

Use UptimeRobot (the frozen stack's named service) or an equivalent service only if Zhi Hao deliberately
approves the substitution. Create the account under a founder-controlled address with MFA and store recovery
details in the team's password manager.

## Alert contacts first

Create and verify two independent alert contacts, one for each founder. At minimum, use each founder's own
email address; add UptimeRobot mobile push or the founders' shared Telegram channel if available on the chosen
plan. Apply **both contacts to both monitors**. Do not rely on one founder forwarding alerts.

Run the provider's test notification for every contact and record who received it, channel, and UTC time.

## Monitor 1 — backend liveness

- Type: HTTPS
- Friendly name: `Astrail backend /health`
- URL: `https://astrail-backend.onrender.com/health`
- Method: GET
- Interval: 5 minutes (or the shortest free-plan interval)
- Expected: HTTP 200; if keyword/content matching is available, require `"status":"ok"`
- Redirects: follow HTTPS redirects; TLS/certificate errors must fail
- Alert contacts: both founders

This is a liveness monitor only. `/health` intentionally does not validate Supabase schema or dependency
readiness; a green result is not proof that trip generation works.

## Monitor 2 — public frontend

- Type: HTTPS
- Friendly name: `Astrail web astrail.xyz`
- URL: `https://astrail.xyz`
- Method: GET
- Interval: 5 minutes (or the shortest free-plan interval)
- Expected: HTTP 200
- Redirects: follow HTTPS redirects; TLS/certificate errors must fail
- Alert contacts: both founders

## Verification and operating rule

After creation, confirm both monitors show green from at least two locations/checks. Then schedule a brief,
founder-approved maintenance test (pause/alter a monitor or use the provider's test-alert control; do not take
production down) and prove both founders receive the DOWN/test alert and the recovery alert. Record monitor
IDs, screenshots, UTC timestamps, and recipients in the release evidence.

Do not mark live-ops complete until a frontend Sentry test event is scrubbed and visible **and** both founders
have received monitor alerts. Never test by writing to production data or creating another backend service.
