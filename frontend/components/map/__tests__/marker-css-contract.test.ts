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
//
// Accepted holes, by design: (1) inline styles / Tailwind utilities applied to the
// marker element in TSX are outside this contract — a new marker-root class must
// also be added to MARKER_ROOT below to be covered; (2) `.pin-land` (GenerationScene)
// pre-dates this contract and animates `transform` in its keyframes — it is NOT in
// MARKER_ROOT and its landing animation visibly overrides Mapbox positioning while
// it plays (tracked separately).

// Every stylesheet the app loads (app/layout.tsx imports all three) — a marker-root
// rule added to palette.css or type.css is just as load-bearing as one in globals.css.
// Parser limitation (accepted): plain and @media-nested rules only; CSS `&` nesting
// inside a marker-root rule would not be attributed to it. None is in use today.
const CSS_FILES = ['globals.css', 'palette.css', 'type.css']
const css = CSS_FILES
  .map((f) => readFileSync(resolve(__dirname, '../../../app', f), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '') // strip comments so commented-out rules don't trip it

// Innermost `selector { body }` pairs — rules nested in @media blocks match too,
// because their bodies contain no braces once comments are stripped.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }))

// `.constellation-pin` or `.constellation-pin--modifier`, but never
// `.constellation-pin-card…` (single hyphen = child element, not a marker root).
const MARKER_ROOT = /\.(?:constellation-pin(?:--[\w-]+)?|hotel-hub-pin)(?![\w-])/

// Case-insensitive (CSS property names are), vendor-prefix tolerant (-webkit-transform).
const POSITIONING_PROPS = /(?:^|[;\s])(?:-\w+-)?(transform|scale|translate|rotate)\s*:/i

describe('marker CSS contract: Mapbox owns marker-root positioning', () => {
  const markerRules = rules.filter((r) => MARKER_ROOT.test(r.selector))

  it('finds the exact marker-root rule set (guard against drift AND parser blind spots)', () => {
    // Exact-set, not contains: the innermost-brace parser makes a rule VANISH from
    // markerRules if it gains CSS nesting (or a stray brace garbles its selector) —
    // a vanished rule would otherwise pass every absence-assertion silently.
    // Adding/removing a marker-root rule must update this list consciously.
    const selectors = [...new Set(markerRules.map((r) => r.selector))].sort()
    expect(selectors).toEqual([
      '.constellation-pin',
      // The three source-kind rules below are DESCENDANT selectors: they target a CHILD (the
      // SVG teardrop path), which is free to transform. The parser attributes them to the root
      // because they start with a root class, and being over-covered is the safe direction — a
      // transform added here would still be caught, and they declare only fill/stroke.
      // They replaced root-level `.constellation-pin--<kind>` rules from the dot era, which
      // styled a `border` against `border: 0` and drew an `outline` — a RECTANGLE around the
      // teardrop's bounding box, since an outline follows the box and not the shape.
      '.constellation-pin--agent_suggested .constellation-pin__drop-body',
      '.constellation-pin--receding',
      '.constellation-pin--receding.constellation-pin--selected',
      '.constellation-pin--selected',
      '.constellation-pin--selected .constellation-pin__drop-body',
      '.constellation-pin--user_requested .constellation-pin__drop-body',
      '.hotel-hub-pin',
    ])
  })

  it.each([
    ['transform'], ['scale'], ['translate'], ['rotate'],
  ])('no marker-root rule declares `%s`', (prop) => {
    for (const { selector, body } of markerRules) {
      const declared = [...body.matchAll(new RegExp(POSITIONING_PROPS.source, 'gi'))]
        .map((m) => m[1].toLowerCase())
      if (declared.includes(prop)) {
        expect.fail(
          `\`${selector}\` declares \`${prop}\` — it composes with (or is overridden by) `
          + `Mapbox's inline marker transform and shifts the pin off its anchor. `
          + `Grow/shrink via width/height instead.`,
        )
      }
    }
  })

  it('transitions on marker roots do not reference positioning props', () => {
    // A `transition: scale 200ms` (or `transition-property: scale`) line is the tell
    // that someone re-introduced an individual transform property on a state class.
    for (const { selector, body } of markerRules) {
      for (const transition of body.matchAll(/transition(?:-property)?\s*:\s*([^;]+)/gi)) {
        expect(
          /\b(transform|scale|translate|rotate)\b/i.test(transition[1]),
          `\`${selector}\` transitions a positioning property: \`${transition[1].trim()}\``,
        ).toBe(false)
      }
    }
  })

  it('keyframes animated by marker roots do not declare positioning props', () => {
    // CSS animations OVERRIDE the inline style while they play — a keyframe that
    // animates `transform` replaces Mapbox's positioning entirely for its duration.
    // Currently no marker-root rule declares `animation`; this arms the guard.
    const RESERVED = new Set(['none', 'infinite', 'linear', 'ease', 'ease-in', 'ease-out',
      'ease-in-out', 'forwards', 'backwards', 'both', 'normal', 'reverse', 'alternate',
      'alternate-reverse', 'running', 'paused', 'step-start', 'step-end'])
    for (const { selector, body } of markerRules) {
      const anim = body.match(/animation(?:-name)?\s*:\s*([^;]+)/)
      if (!anim) continue
      const names = anim[1].split(/[\s,]+/).filter(
        (tok) => /^[a-zA-Z_][\w-]*$/.test(tok) && !RESERVED.has(tok) && !tok.startsWith('cubic-'),
      )
      for (const name of names) {
        const start = css.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`))
        expect(start, `\`${selector}\` animates \`${name}\` but no @keyframes found`).toBeGreaterThan(-1)
        // Brace-count to the end of the @keyframes block.
        let depth = 0; let i = css.indexOf('{', start); let end = i
        for (; i < css.length; i++) {
          if (css[i] === '{') depth++
          else if (css[i] === '}' && --depth === 0) { end = i; break }
        }
        const block = css.slice(start, end)
        expect(
          POSITIONING_PROPS.test(block.replace(/@keyframes[^{]+/, '')),
          `@keyframes \`${name}\` (animated by \`${selector}\`) declares a positioning property — `
          + `it would override Mapbox's inline marker transform while playing`,
        ).toBe(false)
      }
    }
  })

  it('selected pin grows via width/height (the fix this contract protects)', () => {
    // Guards the positive half of the fix: deleting the size growth would leave the
    // selected state visually indistinct while every absence-assertion still passed.
    const base = markerRules.find((r) => r.selector === '.constellation-pin')!
    const selected = markerRules.find((r) => r.selector === '.constellation-pin--selected')!
    const px = (body: string, prop: 'width' | 'height') =>
      Number(body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([\\d.]+)px`))?.[1])
    expect(px(selected.body, 'width')).toBeGreaterThan(px(base.body, 'width'))
    expect(px(selected.body, 'height')).toBeGreaterThan(px(base.body, 'height'))
  })
})
