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
        {/* Suit: one continuous silhouette — shoulders, legs, boots. */}
        <path
          vectorEffect="non-scaling-stroke"
          d="M 16.5 20.3 C 14.5 20.8 13.4 22.2 13.2 24 L 13.2 29.5 C 13.2 32.5 13.8 35 14.2 37.5 L 14.2 40.6 Q 14.2 42 15.6 42 L 19.2 42 Q 20 42 20 41.2 L 20 36 Q 20 34.4 20.9 34.4 L 21.1 34.4 Q 22 34.4 22 36 L 22 41.2 Q 22 42 22.8 42 L 26.6 42 Q 28 42 28 40.6 L 28 37.5 C 28 34 27.6 31 27.4 28.5 L 27.4 24 C 27.3 22.2 26.2 20.8 24.2 20.3 Z"
        />
        {/* Life-support pack hugging the back. */}
        <path vectorEffect="non-scaling-stroke" d="M 13.2 23.5 L 11 23.5 Q 9.8 23.5 9.8 24.7 L 9.8 29.3 Q 9.8 30.5 11 30.5 L 13.2 30.5" />
        {/* Helmet: the constellation pin — dark disc in a brass ring, in both worlds. */}
        <circle vectorEffect="non-scaling-stroke" cx="20.5" cy="13" r="6.5" fill="var(--night-deep)" />
        <path vectorEffect="non-scaling-stroke" d="M 22.8 9.6 A 4 4 0 0 0 20 7.2" opacity="0.6" />
        {/* Boot cuffs. */}
        <path vectorEffect="non-scaling-stroke" d="M 14.2 38.8 L 20 38.8 M 22 38.8 L 28 38.8" opacity="0.6" />
        {/* Glove raised from the shoulder, sketching the route. */}
        <path vectorEffect="non-scaling-stroke" d="M 25.2 22.6 C 27.4 21.8 29.3 20.4 31 18.6" />
        {/* The trail: a dotted star path from the glove to the destination. */}
        <path
          className={variant === 'waiting' ? 'astronaut-trail astronaut-trail--waiting' : 'astronaut-trail'}
          vectorEffect="non-scaling-stroke"
          d="M 34.2 17.6 C 40.5 20.8 47.5 20.6 53.5 17.8 C 56.6 16.3 59.2 14.8 61 13.4"
          strokeWidth="2"
          strokeDasharray="0.1 5.5"
        />
      </g>
      {/* The destination star. */}
      <path
        d="M 63.5 7.5 C 64.1 10.4 65.1 11.4 68 12 C 65.1 12.6 64.1 13.6 63.5 16.5 C 62.9 13.6 61.9 12.6 59 12 C 61.9 11.4 62.9 10.4 63.5 7.5 Z"
        fill="currentColor"
      />
    </svg>
  )
}
