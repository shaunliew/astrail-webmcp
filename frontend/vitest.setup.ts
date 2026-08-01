import '@testing-library/jest-dom/vitest'

// jsdom has no ResizeObserver; TripMap observes its container to keep the Mapbox
// canvas in sync with layout changes. A no-op stub lets the component mount in tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// jsdom has no matchMedia either; components that read a media query at render — reduced-motion
// or breakpoint checks (e.g. DoorChrome, TripsList) — call window.matchMedia and would throw.
// A stub reporting "no match" with no-op listeners lets them mount. Mirrors the stub above.
if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}
