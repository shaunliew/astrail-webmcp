# Supabase dashboard setup — beta email OTP auth

One-time manual configuration (not in code). Do these in the Supabase project dashboard
before testing the beta sign-in flow.

## 1. Enable email OTP sign-in
Authentication → Providers → Email: **Enable** the provider.
No password requirements apply — the app uses `signInWithOtp` (passwordless).

## 2. Custom SMTP is REQUIRED FIRST — not deferrable (corrected 2026-07-07)
Supabase locks email template editing behind custom SMTP. On the default built-in
mailer, **Emails → Magic link or OTP** shows Subject/Body as read-only with a
"Set up custom SMTP to edit templates" banner — there is no way to render `{{ .Token }}`
without this step. Do it before Step 3, not "before inviting external users":

1. Sign up at a transactional email provider (Resend's free tier — 100/day — is enough
   for beta). Create an API key.
2. Supabase → **Project Settings → Authentication → SMTP Settings** → enable **Custom SMTP**.
3. Host `smtp.resend.com`, port `465`, username `resend`, password = the API key,
   sender name `Astrail`, sender email per your verified domain (or the provider's
   test sender for low-volume use).
4. Save. Confirm **Emails → Magic link or OTP** now shows an editable Subject/Body
   (banner gone) before continuing.

## 3. Send a 6-digit code instead of a magic link
Authentication → Emails → **Magic link or OTP**: switch Body to **Source** view and
replace the link with the token, e.g.

    <h2>Your Astrail sign-in code</h2>
    <p>Enter this code in the app:</p>
    <h1>{{ .Token }}</h1>
    <p>It expires in 10 minutes. If you didn't request it, ignore this email.</p>

(`{{ .Token }}` is the 6-digit OTP; when the template contains it, users get a code.)
Do the same for the **Sign Up / Confirm signup** template if your project version splits them.

## 4. Shorten OTP expiry
Authentication → Providers → Email → **Email OTP expiration**: set to `600` seconds (10 min).

## 5. Rate limits (know the ceiling)
Custom SMTP (step 2) already lifts you off the built-in mailer's few-emails/hour cap.
Resend's free tier (100/day) is enough for beta-scale testing; raise
Authentication → Rate Limits (and your provider's plan) before a larger real launch.

## 6. Redirect URLs (unchanged for OTP)
OTP verification happens in-app (`verifyOtp`) — no redirect URL config needed.
Keep the existing Site URL for deploys: Authentication → URL Configuration.
