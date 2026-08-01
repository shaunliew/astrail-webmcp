'use client'

import { memo, useEffect, useRef } from 'react'

/* Calm night-sky backdrop for the door stage. Not the warp/hyperspace field it started as —
   toned down to Astrail's constellation mood: faint starlight points that drift almost
   imperceptibly and twinkle on a slow sine. Painted on a transparent canvas so the stage's
   brass-wash + night-blue radial gradients (palette.css .stage) still read through, and so the
   .stage::after vignette dims the edge stars for free. Honours prefers-reduced-motion by
   rendering a single static frame — no rAF loop, no twinkle. */

type Star = {
  x: number // normalized 0..1 (multiplied by backing width at draw time — survives resize)
  y: number
  r: number // radius in CSS px (scaled by DPR when drawn)
  a: number // base alpha
  tw: number // twinkle angular speed (rad/ms)
  ph: number // twinkle phase offset (rad)
  vx: number // drift, normalized units / ms
  vy: number
  brass: boolean // a few warm accent stars, the rest starlight
}

// Palette tokens as literal RGB — canvas can't read CSS vars. Kept in sync with palette.css:
//   starlight #F5F1E8 · brass-bright #E8B667.
const STARLIGHT = '245,241,232'
const BRASS = '232,182,103'

function makeStars(w: number, h: number): Star[] {
  // Density tuned for a calm-but-present sky; clamped so tiny and 4K viewports both behave.
  const count = Math.max(90, Math.min(300, Math.round((w * h) / 6500)))
  const stars: Star[] = []
  for (let i = 0; i < count; i++) {
    const brass = Math.random() < 0.1 // ~1 in 10 is a warm accent
    // Gentle rise-and-drift: mostly upward, a touch of lateral wander. Values are tiny —
    // ~0.3–0.8% of the frame per second — so motion registers as "alive", never "moving".
    const speed = 0.000004 + Math.random() * 0.000004
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.2 // up ± ~34°
    stars.push({
      x: Math.random(),
      y: Math.random(),
      r: brass ? 1 + Math.random() * 0.8 : 0.5 + Math.random() * 1,
      a: brass ? 0.4 + Math.random() * 0.35 : 0.18 + Math.random() * 0.47,
      tw: 0.0006 + Math.random() * 0.0012, // period ~3.5–10s
      ph: Math.random() * Math.PI * 2,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      brass,
    })
  }
  return stars
}

export const Starfield = memo(function Starfield({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    let stars: Star[] = []
    let w = 0
    let h = 0
    let dpr = 1
    let raf = 0
    let last = 0

    function resize() {
      const rect = parent!.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, 2) // cap DPR — 3x on phones buys nothing here
      w = Math.max(1, Math.round(rect.width * dpr))
      h = Math.max(1, Math.round(rect.height * dpr))
      canvas!.width = w
      canvas!.height = h
      // Regenerate only on the first size or when area shifts enough to matter — keeps the sky
      // stable through the globe's presence and small layout nudges.
      if (!stars.length) stars = makeStars(rect.width, rect.height)
    }

    function draw(t: number) {
      ctx!.clearRect(0, 0, w, h)
      const dt = last ? t - last : 0
      last = t
      for (const s of stars) {
        if (!reduced) {
          s.x += s.vx * dt
          s.y += s.vy * dt
          if (s.x < 0) s.x += 1
          else if (s.x > 1) s.x -= 1
          if (s.y < 0) s.y += 1
          else if (s.y > 1) s.y -= 1
        }
        const alpha = reduced ? s.a * 0.9 : s.a * (0.55 + 0.45 * Math.sin(s.ph + t * s.tw))
        const rgb = s.brass ? BRASS : STARLIGHT
        ctx!.beginPath()
        ctx!.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`
        if (s.brass) {
          ctx!.shadowBlur = 6 * dpr
          ctx!.shadowColor = `rgba(${BRASS},0.5)`
        } else {
          ctx!.shadowBlur = 0
        }
        ctx!.arc(s.x * w, s.y * h, s.r * dpr, 0, Math.PI * 2)
        ctx!.fill()
      }
    }

    function frame(t: number) {
      draw(t)
      raf = requestAnimationFrame(frame)
    }

    resize()
    if (reduced) {
      draw(0) // one static frame, then stop
    } else {
      raf = requestAnimationFrame(frame)
    }

    const ro = new ResizeObserver(() => {
      resize()
      if (reduced) draw(0)
    })
    ro.observe(parent)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 h-full w-full ${className ?? ''}`}
    />
  )
})
