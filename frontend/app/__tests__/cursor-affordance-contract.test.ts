import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Tailwind v4's Preflight dropped v3's `button, [role="button"] { cursor: pointer }` and replaced
// it with nothing — grep the installed preflight.css and it contains no `cursor` declaration at
// all. Every one of this app's ~100 buttons therefore renders with the UA arrow, and nothing on
// any screen looks clickable. `app/globals.css` restores it once, in `@layer base`.
//
// jsdom has no layout engine AND does not apply globals.css to rendered components, so a
// `getComputedStyle(...).cursor` assertion here would be worthless — it would pass on an empty
// stylesheet. What this pins instead is the stylesheet contract, in the same spirit as the
// sibling `components/map/__tests__/marker-css-contract.test.ts`: the rule exists, it reaches the
// elements this app actually clicks, it does NOT reach dead controls, and — the subtle one — it
// lives inside `@layer base` so that every `disabled:cursor-default` / `cursor-not-allowed`
// utility already written in the components still wins on the element it is written on.
//
// The real verification is a browser: this file only guards against the rule being silently
// deleted or "simplified" out of its layer, neither of which any rendering test would catch.

const css = readFileSync(resolve(__dirname, '../globals.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '') // strip comments so prose about cursors cannot satisfy a match

/**
 * The body of every top-level `@layer <name> { ... }` block, brace-matched (the innermost-pair
 * regex the marker contract uses cannot do this — it would hand back the inner rule and lose the
 * layer it sits in, which is exactly the fact under test).
 */
function layerBody(name: string): string | null {
  const open = css.indexOf(`@layer ${name} {`)
  if (open === -1) return null
  let depth = 0
  for (let i = css.indexOf('{', open); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', open) + 1, i)
  }
  return null
}

/**
 * Split a selector list on its top-level commas only. A naive `.split(',')` tears
 * `:not(:disabled, [aria-disabled='true'])` in half and hands back a fragment that trivially
 * fails every exclusion assertion below.
 */
function selectorList(selector: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < selector.length; i++) {
    if (selector[i] === '(') depth++
    else if (selector[i] === ')') depth--
    else if (selector[i] === ',' && depth === 0) {
      out.push(selector.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(selector.slice(start).trim())
  return out.filter(Boolean)
}

/** Innermost `selector { body }` pairs within a chunk of CSS. */
const rulesIn = (chunk: string) =>
  [...chunk.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.replace(/\s+/g, ' ').trim(),
    body,
  }))

const POINTER = /(?:^|[;\s])cursor\s*:\s*pointer\s*(?:;|$)/i

describe('cursor affordance contract: Tailwind v4 dropped the button pointer', () => {
  const base = layerBody('base')

  it('declares the pointer restoration inside @layer base', () => {
    // Not merely "somewhere in globals.css": an unlayered copy of this rule would outrank EVERY
    // `disabled:cursor-*` utility in the components (unlayered styles beat all cascade layers),
    // silently putting a pointer back on disabled controls — the precise bug the excludes prevent.
    expect(base, '@layer base block missing from app/globals.css').not.toBeNull()
    expect(rulesIn(base!).filter((r) => POINTER.test(r.body))).toHaveLength(1)
  })

  const pointerRule = () => rulesIn(base ?? '').find((r) => POINTER.test(r.body))!

  it.each([
    // Covers ~100 onClick sites; every one bar two modal backdrops is a <button>.
    ['button', /(?:^|,\s*)button\b/],
    // RestaurantStrip's <li> becomes role=button only when the suggestion is locatable.
    ['[role="button"]', /(?:^|,\s*)\[role=['"]button['"]\]/],
    // The Budget dropdowns (PlanSheet, TripBriefForm).
    ['select', /(?:^|,\s*)select\b/],
    // TraysScreen's "Prefer to paste Reel links here?" disclosure.
    ['summary', /(?:^|,\s*)summary\b/],
  ])('reaches %s', (_label, pattern) => {
    expect(pointerRule().selector).toMatch(pattern)
  })

  it.each([
    // The real attribute — e.g. the "Plan this trip" gate, disabled until places are selected.
    [':disabled', /:not\([^)]*:disabled[^)]*\)/],
    // The focusable-but-inert pattern, which :disabled does not match.
    ['[aria-disabled="true"]', /:not\([^)]*\[aria-disabled=['"]true['"]\][^)]*\)/],
  ])('excludes %s from every clickable selector it claims', (_label, exclusion) => {
    // Per-selector, not once for the whole rule: a single unguarded selector in the list is
    // enough to hand a pointer to a control that will not respond.
    const claims = selectorList(pointerRule().selector)
      .filter((s) => /^(?:button|\[role|select)/.test(s)) // <summary> has no disabled state
    expect(claims.length).toBeGreaterThan(0)
    for (const selector of claims) expect(selector).toMatch(exclusion)
  })
})
