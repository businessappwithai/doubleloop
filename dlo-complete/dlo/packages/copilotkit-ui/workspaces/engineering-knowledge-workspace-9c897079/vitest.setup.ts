// vitest.setup.ts — runs once per test file, before `globals: true` test bodies execute.
// Registers jest-dom matchers, cleans up the jsdom DOM between tests, turns a stray
// console.error (React act()/key/prop-type warnings included) into a hard test failure so
// warnings can never hide silently in CI, and stubs the two browser APIs jsdom does not
// implement (matchMedia, ResizeObserver) so components that query them don't crash under jsdom.
//
// The TextEncoder/TextDecoder polyfill MUST run first, before any other import: jsdom's
// own TextEncoder does not produce a true Uint8Array instance, which fails esbuild's
// invariant check during test collection and breaks every test file before it can load.
import { TextEncoder, TextDecoder } from "node:util";

Object.assign(global, { TextEncoder, TextDecoder });

import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  originalConsoleError(...args);
  throw new Error(`console.error during test: ${String(args[0])}`);
};

if (typeof window !== "undefined") {
  // A plain function, not `vi.fn()`: the Vitest config sets `restoreMocks: true`, which
  // restores every `vi.fn()`/`vi.spyOn()` mock to a blank implementation after each test —
  // that would silently wipe a stub installed once here at setup-file load time, after the
  // first test in the file ran. Individual tests can still `vi.spyOn(window, "matchMedia")`.
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }

  if (!window.ResizeObserver) {
    class ResizeObserverStub {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
