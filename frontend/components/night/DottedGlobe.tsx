'use client'

import { useEffect, useRef } from 'react'

type SpherePoint = { x: number; y: number; z: number }
type City = { name: string; lat: number; lng: number }
type ProjectedPoint = { x: number; y: number; depth: number }

const POINT_COUNT = 1000
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const SPHERE_POINTS: SpherePoint[] = Array.from({ length: POINT_COUNT }, (_, index) => {
  const y = 1 - (index / (POINT_COUNT - 1)) * 2
  const radius = Math.sqrt(1 - y * y)
  const theta = GOLDEN_ANGLE * index
  return { x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius }
})

const CITIES: City[] = [
  { name: 'Tokyo', lat: 35.6762, lng: 139.6503 },
  { name: 'Singapore', lat: 1.3521, lng: 103.8198 },
  { name: 'London', lat: 51.5074, lng: -0.1278 },
  { name: 'New York', lat: 40.7128, lng: -74.006 },
  { name: 'Paris', lat: 48.8566, lng: 2.3522 },
  { name: 'Sydney', lat: -33.8688, lng: 151.2093 },
]

const ARC_PAIRS: [number, number][] = [[0, 1], [1, 2], [3, 4]]

function cityToSpherePoint(city: City): SpherePoint {
  const lat = (city.lat * Math.PI) / 180
  const lng = (city.lng * Math.PI) / 180
  const cosLat = Math.cos(lat)
  return { x: cosLat * Math.cos(lng), y: Math.sin(lat), z: cosLat * Math.sin(lng) }
}

const CITY_POINTS = CITIES.map(cityToSpherePoint)

function project(point: SpherePoint, rotation: number, size: number): ProjectedPoint | null {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const x = point.x * cos + point.z * sin
  const depth = -point.x * sin + point.z * cos

  if (depth <= 0) return null

  const globeRadius = size * 0.42
  return {
    x: size / 2 + x * globeRadius,
    y: size / 2 - point.y * globeRadius,
    depth,
  }
}

function quadraticPoint(
  start: ProjectedPoint,
  control: { x: number; y: number },
  end: ProjectedPoint,
  t: number,
): { x: number; y: number } {
  const inverse = 1 - t
  return {
    x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
    y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
  }
}

export default function DottedGlobe({ size = 520 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    context.setTransform?.(dpr, 0, 0, dpr, 0, 0)

    let rotation = 0
    let frameId: number | null = null
    let lastFrameTime: number | null = null
    const motionQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null

    const drawCircle = (x: number, y: number, radius: number, fillStyle: string) => {
      if (typeof context.beginPath !== 'function' || typeof context.arc !== 'function' || typeof context.fill !== 'function') return
      context.beginPath()
      context.fillStyle = fillStyle
      context.arc(x, y, radius, 0, Math.PI * 2)
      context.fill()
    }

    const draw = (time: number) => {
      if (typeof context.clearRect !== 'function') return
      context.clearRect(0, 0, size, size)

      for (const point of SPHERE_POINTS) {
        const projected = project(point, rotation, size)
        if (!projected) continue
        const alpha = 0.12 + projected.depth * 0.62
        const radius = 0.55 + projected.depth * 0.45
        drawCircle(projected.x, projected.y, radius, `rgba(247, 243, 232, ${alpha.toFixed(3)})`)
      }

      const cityProjections = CITY_POINTS.map((point) => project(point, rotation, size))
      for (const [index, [startIndex, endIndex]] of ARC_PAIRS.entries()) {
        const start = cityProjections[startIndex]
        const end = cityProjections[endIndex]
        if (!start || !end || typeof context.beginPath !== 'function' || typeof context.moveTo !== 'function' || typeof context.quadraticCurveTo !== 'function' || typeof context.stroke !== 'function') continue

        const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
        const arcHeight = Math.hypot(end.x - start.x, end.y - start.y) * 0.24 + size * 0.02
        const control = { x: midpoint.x, y: midpoint.y - arcHeight }
        context.beginPath()
        context.strokeStyle = 'rgba(239, 201, 141, 0.6)'
        context.lineWidth = 0.7
        context.setLineDash?.([1.5, 4])
        context.moveTo(start.x, start.y)
        context.quadraticCurveTo(control.x, control.y, end.x, end.y)
        context.stroke()
        context.setLineDash?.([])

        const particle = quadraticPoint(start, control, end, (time / 16000 + index * 0.31) % 1)
        drawCircle(particle.x, particle.y, 1.2, 'rgba(247, 243, 232, 0.95)')
      }

      for (const [index, projected] of cityProjections.entries()) {
        if (!projected) continue
        const pulse = 2 + Math.sin(time / 900 + index) * 0.7
        drawCircle(projected.x, projected.y, pulse * 2.5, 'rgba(239, 201, 141, 0.14)')
        drawCircle(projected.x, projected.y, pulse, '#EFC98D')
      }
    }

    const cancelFrame = () => {
      if (frameId === null) return
      window.cancelAnimationFrame(frameId)
      frameId = null
    }

    const staticFrame = () => {
      lastFrameTime = null
      draw(0)
    }

    const animate = (time: number) => {
      if (document.hidden || motionQuery?.matches) {
        frameId = null
        return
      }

      const elapsed = lastFrameTime === null ? 0 : Math.min(100, time - lastFrameTime)
      lastFrameTime = time
      rotation = (rotation + (elapsed / 60000) * Math.PI * 2) % (Math.PI * 2)
      draw(time)
      frameId = window.requestAnimationFrame(animate)
    }

    const startAnimation = () => {
      if (frameId !== null || document.hidden || motionQuery?.matches) return
      lastFrameTime = null
      frameId = window.requestAnimationFrame(animate)
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        cancelFrame()
        staticFrame()
      } else {
        startAnimation()
      }
    }

    const handleMotionChange = () => {
      if (motionQuery?.matches) {
        cancelFrame()
        staticFrame()
      } else {
        startAnimation()
      }
    }

    draw(0)
    if (!document.hidden && !motionQuery?.matches) startAnimation()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    if (motionQuery) {
      if (typeof motionQuery.addEventListener === 'function') {
        motionQuery.addEventListener('change', handleMotionChange)
      } else {
        motionQuery.addListener(handleMotionChange)
      }
    }

    return () => {
      cancelFrame()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (!motionQuery) return
      if (typeof motionQuery.removeEventListener === 'function') {
        motionQuery.removeEventListener('change', handleMotionChange)
      } else {
        motionQuery.removeListener(handleMotionChange)
      }
    }
  }, [size])

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      aria-hidden="true"
      role="presentation"
      className="pointer-events-none block"
      style={{ width: size, height: size }}
    />
  )
}
