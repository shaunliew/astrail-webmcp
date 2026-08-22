import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Mapbox GL positions every custom marker element via an INLINE style.transform —
// `translate(pos.x px, pos.y px) translate(-50%,-50%) …` (Marker._updateDOM). The CSS
// individual transform properties (`scale`, `translate`, `rotate`) compose OUTSIDE the
// `transform` property (CSS Transforms Level 2), so declaring any of them on a marker
// ROOT class multiplies/offsets Mapbox's pixel translation and drags the pin off its
// geographic anchor — a selected pin at screen x=866 rendered 128px to the right under
// `scale: 1.15`. Declaring `transform` itself is no better: it is overridden by the
// inline style entirely. Marker roots grow via width/height instead (the -50% anchor
// translate is relative to the element's own size, so the center stays put).
//
// Marker ROOT classes (elements passed to `new mapboxgl.Marker({ element })`):
//   .constellation-pin + its --modifiers  (TripMap, StoryRevealMap, TripMapDashboard)
//   .hotel-hub-pin                        (TripMap hub mode)
// Child elements (e.g. .constellation-pin-card) are NOT covered — Mapbox does not
// position them, so they may transform freely.

const css = readFileSync(resolve(__dirname, '../../../app/globals.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '') // strip comments so commented-out rules don't trip it

// Innermost `selector { body }` pairs — rules nested in @media blocks match too,
// because their bodies contain no braces once comments are stripped.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }))

// `.constellation-pin` or `.constellation-pin--modifier`, but never
// `.constellation-pin-card…` (single hyphen = child element, not a marker root).
const MARKER_ROOT = /\.(?:constellation-pin(?:--[\w-]+)?|hotel-hub-pin)(?![\w-])/

const POSITIONING_PROPS = /(?:^|[;\s])(transform|scale|translate|rotate)\s*:/

describe('marker CSS contract: Mapbox owns marker-root positioning', () => {
  const markerRules = rules.filter((r) => MARKER_ROOT.test(r.selector))

  it('finds the marker-root rules (guard against selector drift)', () => {
    const selectors = markerRules.map((r) => r.selector)
    expect(selectors).toContain('.constellation-pin')
    expect(selectors).toContain('.constellation-pin--selected')
    expect(selectors).toContain('.hotel-hub-pin')
  })

  it.each([
    ['transform'], ['scale'], ['translate'], ['rotate'],
  ])('no marker-root rule declares `%s`', (prop) => {
    for (const { selector, body } of markerRules) {
      const match = body.match(POSITIONING_PROPS)
      if (match && match[1] === prop) {
        expect.fail(
          `\`${selector}\` declares \`${prop}\` — it composes with (or is overridden by) `
          + `Mapbox's inline marker transform and shifts the pin off its anchor. `
          + `Grow/shrink via width/height instead.`,
        )
      }
    }
  })

  it('transition shorthand on marker roots does not reference positioning props', () => {
    // A `transition: scale 200ms` line is the tell that someone re-introduced an
    // individual transform property on a state class.
    for (const { selector, body } of markerRules) {
      const transition = body.match(/transition\s*:\s*([^;]+)/)
      if (!transition) continue
      expect(
        /\b(transform|scale|translate|rotate)\b/.test(transition[1]),
        `\`${selector}\` transitions a positioning property: \`${transition[1].trim()}\``,
      ).toBe(false)
    }
  })
})
