import '@testing-library/jest-dom/vitest'

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverMock, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
  configurable: true,
})
Object.defineProperty(window, 'scrollTo', { value: () => undefined, configurable: true })
Object.defineProperty(window, 'requestAnimationFrame', {
  value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  configurable: true,
})
Object.defineProperty(window, 'cancelAnimationFrame', {
  value: (id: number) => window.clearTimeout(id),
  configurable: true,
})
