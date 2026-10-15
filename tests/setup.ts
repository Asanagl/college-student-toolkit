import "@testing-library/jest-dom/vitest";

// Ant Design reads matchMedia during component setup.  jsdom does not expose
// it, so tests provide the smallest browser-compatible implementation.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  writable: true,
  value: ResizeObserverMock,
});

Object.defineProperty(globalThis, "scrollTo", {
  writable: true,
  value: () => undefined,
});

Object.defineProperty(window, "getComputedStyle", {
  writable: true,
  value: () => ({ getPropertyValue: () => "" }),
});
