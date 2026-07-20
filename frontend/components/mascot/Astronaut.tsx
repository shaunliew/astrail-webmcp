// The astronaut traveler — Astrail's mascot (DESIGN.md §12 G6; spec in docs/DESIGN-DRAFT.md §7).
// Line-art in the system's single 1.5px brass stroke. Two deliberate quotes of the
// product's own vocabulary: the helmet is a constellation pin (dark disc, brass ring,
// globals.css .constellation-pin), and the glove sketches a dotted star path to the
// destination star — Astrail drawing the route. Appears only in waiting and empty
// moments; never on the map canvas, never in the itinerary.

type AstronautProps = {
  /** Rendered height in px — the mascot stays small (24–48 per the spec). */
  size?: number
  /** 'waiting' flows the trail dots toward the star — the only state that may animate. */
  variant?: 'idle' | 'waiting'
  /** Accessible name for meaningful instances. Omit for decorative ones (aria-hidden). */
  label?: string
  className?: string
}

export default function Astronaut({ size = 48, variant = 'idle', label, className }: AstronautProps) {
  // Non-scaling strokes mean detail density is a per-size decision: below 32px the
  // suit hardware (glint, chest panel, boot cuffs) merges into noise, so it drops out
  // and the silhouette carries the figure alone.
  const detailed = size >= 32
  // Trail dot pitch is in viewBox units, so it shrinks with size — at 24px a 5.6
  // pitch fuses into a solid line. Below 40px the pitch doubles to hold the same
  // on-screen dot spacing. Both values divide the animation's -11.2 dashoffset
  // cycle exactly, so the waiting loop stays seamless at every size.
  const pitch = size < 40 ? 11.2 : 5.6
  return (
    <svg
      data-mascot="astronaut"
      width={size * 1.5}
      height={size}
      viewBox="0 0 72 48"
      fill="none"
      className={className ? `text-[var(--brass-bright)] ${className}` : 'text-[var(--brass-bright)]'}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {/* Far arm: bows out from the body the way a pressurized suit holds it. */}
        <path
          vectorEffect="non-scaling-stroke"
          d="M 15.4 19.6 C 13.9 20.0 13.1 20.8 12.9 21.9 C 12.4 23.9 11.6 26.4 11.2 28.4 Q 10.9 29.8 12.0 30.1 Q 13.0 30.4 13.5 29.2 C 14.1 27.6 14.7 26.2 15.2 24.9"
        />
        {/* Suit: collar, tapered torso, legs in a slight stance, boots, and the raised
            arm — one closed silhouette ending in a mitt aimed along the trail. */}
        <path
          vectorEffect="non-scaling-stroke"
          d="M 15.4 19.6 C 15.6 21.4 15.8 22.8 15.6 24.6 L 15.8 31.4 C 15.7 34.2 15.2 36.8 15.1 39.5 L 14.1 40.9 Q 13.7 42.4 15.1 42.4 L 18.0 42.4 Q 18.9 42.4 18.9 41.2 L 19.0 34.9 Q 19.2 32.9 20.5 32.9 Q 21.8 32.9 22.0 34.9 L 22.1 41.2 Q 22.1 42.4 23.0 42.4 L 26.4 42.4 Q 27.8 42.4 27.4 40.9 L 26.4 39.5 C 26.3 36.8 26.5 34.2 26.4 31.4 L 26.8 24.4 C 27.7 23.9 28.7 23.1 29.8 22.0 C 31.1 20.9 32.3 19.3 33.0 17.7 Q 33.6 16.3 34.1 15.5 Q 33.2 15.2 32.1 16.0 C 30.8 17.1 30.0 17.8 29.0 18.6 C 28.2 19.2 27.1 19.5 25.8 19.5 Z"
        />
        {/* Helmet: the constellation pin — dark disc in a brass ring, in both worlds.
            The disc lightens to warm ink inside .paper-scope via --astronaut-visor. */}
        <circle
          vectorEffect="non-scaling-stroke"
          cx="20.3"
          cy="11.8"
          r="7"
          fill="var(--astronaut-visor, var(--night-deep))"
        />
        {detailed && (
          <>
            {/* Visor glint + chest panel + boot cuffs: suit hardware, ≥32px only. */}
            <path vectorEffect="non-scaling-stroke" d="M 23.7 9.5 A 4.5 4.5 0 0 0 20.5 6.6" opacity="0.6" />
            <rect vectorEffect="non-scaling-stroke" x="18.9" y="23.2" width="4.4" height="3.0" rx="0.8" opacity="0.55" />
            <path vectorEffect="non-scaling-stroke" d="M 15.1 40.0 L 18.9 40.0 M 22.1 40.0 L 26.4 40.0" opacity="0.6" />
          </>
        )}
        {/* The trail: a dotted star path from the glove to the destination. */}
        <path
          className={variant === 'waiting' ? 'astronaut-trail astronaut-trail--waiting' : 'astronaut-trail'}
          vectorEffect="non-scaling-stroke"
          d="M 36 15.6 C 42 18.6 48.5 18.4 54.2 15.9 C 57.2 14.6 59.6 13.3 61.2 12.1"
          strokeWidth="2"
          strokeDasharray={`0.1 ${pitch - 0.1}`}
        />
      </g>
      {/* The destination star. */}
      <path
        d="M 64 6.3 C 64.6 9.2 65.6 10.2 68.5 10.8 C 65.6 11.4 64.6 12.4 64 15.3 C 63.4 12.4 62.4 11.4 59.5 10.8 C 62.4 10.2 63.4 9.2 64 6.3 Z"
        fill="currentColor"
      />
    </svg>
  )
}
