/* Shared story constants. Seat truth (ZH, 2026-08-02): pre-launch = ZERO
   claimed, "boarding soon", waitlist as primary CTA. No invented numbers —
   the classic landing's "no fake scarcity" promise holds here too. */
export const SEATS_TOTAL = 25
export const SEATS_CLAIMED = 0
export const BOARDING_OPEN = false

export const CLIPS = {
  // take 5: enters empty stage → stops right-third → SETTLES STANDING (holds)
  coldOpen: '/landing/clips/beat0-coldopen.mp4?v=5',
  // v4: anchored to take 5's true final standing frame (query busts stale caches)
  coldOpenIdle: '/landing/clips/beat0-idle.mp4?v=4',
  phoneScroll: '/landing/clips/beat1-phonescroll.mp4',
  spark: '/landing/clips/beat2-spark.mp4',
  frenzy: '/landing/clips/beat25-frenzy.mp4',
  overwhelm: '/landing/clips/beat3-overwhelm.mp4',
  rescue: '/landing/clips/beat4a-rescue.mp4',
  flyDown: '/landing/clips/beat4b-flydown.mp4',
  cta: '/landing/clips/beat7-cta.mp4',
} as const

/* Real app screenshots (swap-ready). Captured 2026-08-02 from the live app
   as the Aster demo account (no PII) at 1440x900, webp q85.
   undefined → the section renders a labeled slot instead. */
export const SCREENS: {
  createTrail?: string
  reelLibrary?: string
  tripWorkspace?: string
} = {
  createTrail: '/landing/screens/create-trail.webp',
  reelLibrary: '/landing/screens/reel-library.webp',
  tripWorkspace: '/landing/screens/trip-workspace.webp',
}

/* Fresh demo recording (Zhi Hao filming). Set when the file lands. */
export const DEMO_VIDEO_SRC: string | undefined = undefined

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
