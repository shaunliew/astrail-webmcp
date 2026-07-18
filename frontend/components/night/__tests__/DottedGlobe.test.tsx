import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import DottedGlobe from '@/components/night/DottedGlobe'

const contextStub = {
  arc: vi.fn(),
  beginPath: vi.fn(),
  clearRect: vi.fn(),
  fill: vi.fn(),
  moveTo: vi.fn(),
  quadraticCurveTo: vi.fn(),
  setLineDash: vi.fn(),
  setTransform: vi.fn(),
  stroke: vi.fn(),
} as unknown as CanvasRenderingContext2D

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DottedGlobe', () => {
  it('renders a decorative canvas at the requested size', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(contextStub)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { container } = render(<DottedGlobe size={320} />)
    const canvas = container.querySelector('canvas')

    expect(canvas).toBeInTheDocument()
    expect(canvas).toHaveAttribute('role', 'presentation')
    expect(canvas).toHaveAttribute('width', '320')
    expect(canvas).toHaveAttribute('height', '320')
    expect(canvas).toHaveStyle({ width: '320px', height: '320px' })
  })

  it('can unmount when the canvas context is only a minimal stub', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(contextStub)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { unmount } = render(<DottedGlobe />)
    expect(() => unmount()).not.toThrow()
  })
})
