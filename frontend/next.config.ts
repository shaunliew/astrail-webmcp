import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Backend origin for POST /generate-trip and the SSE stream (connect-src also
// governs EventSource). Dev defaults to localhost:8000; deploys set
// NEXT_PUBLIC_BACKEND_URL to the Render URL (see .env.example).
const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://*.supabase.co";
const isProduction = process.env.NODE_ENV === "production";

const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  "'wasm-unsafe-eval'",
  "https://tally.so",
  process.env.NODE_ENV === "development" ? "'unsafe-eval'" : "",
]
  .filter(Boolean)
  .join(" ");

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https://img.youtube.com https://i.ytimg.com https://*.cdninstagram.com https://*.fbcdn.net ${supabaseUrl}`,
  "font-src 'self' data:",
  `connect-src 'self' ${backendUrl} ${supabaseUrl} https://tally.so https://*.supabase.co https://api.mapbox.com https://events.mapbox.com https://us.i.posthog.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io`,
  "frame-src https://tally.so https://www.youtube.com https://www.youtube-nocookie.com",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://tally.so",
  "frame-ancestors 'none'",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin-allow-popups",
  },
  ...(isProduction ? [{
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  }] : []),
];

const nextConfig: NextConfig = {
  // Two Next servers started in this directory SHARE `.next/` and overwrite each other's
  // chunks — the running one then 500s with `Cannot read properties of undefined (reading
  // 'call')` from __webpack_require__, which reads as an app bug rather than a collision.
  // Set NEXT_DIST_DIR to give a second server (e.g. the NEXT_PUBLIC_MOCK_AUTH fixture
  // harness) its own build dir. Unset everywhere else, so deploys are unaffected.
  // Side effect worth knowing: Next rewrites tsconfig.json to add "<distDir>/types" to
  // `include` (and reformats the file while it is there). Run
  // `git checkout frontend/tsconfig.json` after a harness session.
  // Gated on NODE_ENV: the knob exists solely so two LOCAL dev servers stop fighting over one
  // build dir. Ungated, a stray NEXT_DIST_DIR in Vercel's env would silently repoint a
  // production build's output — a deployment risk taken on for a dev convenience.
  distDir: (!isProduction && process.env.NEXT_DIST_DIR) || ".next",
  poweredByHeader: false,
  async redirects() {
    return [
      // /classic was the pre-pivot landing; retired for launch (its "we'll send a beta
      // invite" copy promised a flow that never shipped, and it duplicated the Tally
      // waitlist under a conflicting purpose — launch legal precautions A3). The page
      // component is kept in git history but no longer served or indexed.
      { source: "/classic", destination: "/", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  telemetry: false,
  silent: !process.env.CI,
  widenClientFileUpload: false,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  webpack: {
    automaticVercelMonitors: false,
    treeshake: {
      removeDebugLogging: true,
      removeTracing: true,
    },
  },
});
