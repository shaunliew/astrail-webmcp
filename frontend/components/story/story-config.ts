/* Shared story constants. Seat truth (ZH, 2026-08-02): pre-launch = ZERO
   claimed, "boarding soon", waitlist as primary CTA. No invented numbers —
   the classic landing's "no fake scarcity" promise holds here too. */
export const SEATS_TOTAL = 25
export const SEATS_CLAIMED = 0
export const BOARDING_OPEN = false

export const CLIPS = {
  // Hero clips: fetched from ZH's Higgsfield account (jobs ada5890a walk-in +
  // 7e16761e seamless idle), compressed to 720p (~4MB/3MB) and committed under
  // /hero (the raw ~50MB /clips masters stay gitignored). Walk-in enters the
  // empty stage → settles standing right-third; idle loops that pose forever.
  coldOpen: '/landing/hero/coldopen.mp4',
  coldOpenIdle: '/landing/hero/idle.mp4',
  phoneScroll: '/landing/clips/beat1-phonescroll.mp4',
  spark: '/landing/clips/beat2-spark.mp4',
  frenzy: '/landing/clips/beat25-frenzy.mp4',
  overwhelm: '/landing/clips/beat3-overwhelm.mp4',
  rescue: '/landing/clips/beat4a-rescue.mp4',
  flyDown: '/landing/clips/beat4b-flydown.mp4',
  // CTA warm bookend: mech descends + waves (Higgsfield job f84b5245),
  // 720p ~5MB, committed under /hero. No baked-in UI (clean empty left).
  cta: '/landing/hero/cta.mp4',
} as const

/* Real app screenshots (swap-ready). Captured 2026-08-02 from the live app
   as the Aster demo account (no PII) at 1440x900, webp q85.
   undefined → the section renders a labeled slot instead. */
export const SCREENS: {
  createTrail?: string
  agentsResearch?: string
  tripWorkspace?: string
} = {
  createTrail: '/landing/screens/create-trail.webp',
  agentsResearch: '/landing/screens/agents-research.webp',
  tripWorkspace: '/landing/screens/trip-workspace.webp',
}

/* 60s beta demo screen-capture, re-encoded to 1080p/silent for web weight. */
export const DEMO_VIDEO_SRC: string | undefined = '/landing/astrail-beta-demo.mp4'

export const STILLS = {
  coldOpen: '/landing/coldopen-hero.webp',
  phoneScroll: '/landing/phone-scroll.webp',
  spark: '/landing/spark.webp',
  frenzy: '/landing/spam-likes.webp',
  overwhelm: '/landing/overwhelm-beat.webp',
  rescueBurst: '/landing/rescue-burst.webp',
  rescueCollect: '/landing/rescue-collect.webp',
  globeKorea: '/landing/globe-korea.webp',
  globeThailand: '/landing/globe-thailand.webp',
  globeSingapore: '/landing/globe-singapore.webp',
  globeJapan: '/landing/globe-japan.webp',
  cta: '/landing/cta.webp',
} as const
