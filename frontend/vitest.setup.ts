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
