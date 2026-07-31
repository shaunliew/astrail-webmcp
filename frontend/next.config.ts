import type { NextConfig } from "next";

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
  `connect-src 'self' ${backendUrl} ${supabaseUrl} https://tally.so https://*.supabase.co https://api.mapbox.com https://events.mapbox.com https://us.i.posthog.com`,
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
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
