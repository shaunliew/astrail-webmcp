import Image from 'next/image'

/* The one Astrail logo primitive. Both variants are sliced from public/astrail_logo.png:
   - `mark`   → the A-swoosh-star glyph alone (tight-cropped to /astrail-mark.png)
   - `lockup` → the glyph over the ASTRAIL wordmark (/astrail-lockup.png)

   The source art is white/chrome on transparent, so it only reads on dark surfaces. Two tones:
   - `chrome`   → renders the art as-is (keeps the metallic sheen). Use ON DARK.
   - `brass`    → recolours the art to a solid palette token via mask-image, so the same shape
                  stays legible on the cream paper cards where white chrome would vanish.
   - `starlight`→ same masking trick, tinted near-white (rare; for muted-on-dark cases).

   Callers pass a target `height`; width follows the crop's aspect ratio automatically. */

type Variant = 'mark' | 'lockup'
type Tone = 'chrome' | 'brass' | 'starlight'

// Aspect = intrinsic width / height of each tight crop (see the generation step).
const ASSET: Record<Variant, { src: string; aspect: number }> = {
  mark: { src: '/astrail-mark.png', aspect: 407 / 318 },
  lockup: { src: '/astrail-lockup.png', aspect: 814 / 478 },
}

const TONE_COLOR: Record<Exclude<Tone, 'chrome'>, string> = {
  brass: 'var(--brass-deep)', // a base hex token — stable across the .app-shell scope remaps
  starlight: 'var(--starlight)',
}

export function AstrailLogo({
  variant = 'mark',
  tone = 'chrome',
  height,
  className,
  alt = 'Astrail',
  priority = false,
}: {
  variant?: Variant
  tone?: Tone
  height: number
  className?: string
  alt?: string
  priority?: boolean
}) {
  const { src, aspect } = ASSET[variant]
  const width = Math.round(height * aspect)

  if (tone === 'chrome') {
    return (
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        priority={priority}
        className={className}
        style={{ height, width }}
      />
    )
  }

  // Masked recolour: the element paints `backgroundColor` only through the art's alpha, so the
  // white-on-transparent glyph becomes a solid brass mark. Metallic sheen is lost by design —
  // a flat brass mark matches the app's brass-on-paper system.
  return (
    <span
      role="img"
      aria-label={alt}
      className={className}
      style={{
        display: 'inline-block',
        width,
        height,
        backgroundColor: TONE_COLOR[tone],
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  )
}
