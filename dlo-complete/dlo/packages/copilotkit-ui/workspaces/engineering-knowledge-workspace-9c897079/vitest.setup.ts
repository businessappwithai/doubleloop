// vitest.setup.ts — runs once per test file, before `globals: true` test bodies execute.
// Registers jest-dom matchers, cleans up the jsdom DOM between tests, turns a stray
// console.error (React act()/key/prop-type warnings included) into a hard test failure so
// warnings can never hide silently in CI, and stubs the two browser APIs jsdom does not
// implement (matchMedia, ResizeObserver) so components that query them don't crash under jsdom.
//
// The TextEncoder/TextDecoder polyfill's primary install point is vitest.global-setup.ts,
// which runs before esbuild's test-collection invariant check. It is reapplied here as a
// backup: jsdom's environment setup (which runs between globalSetup and this file) may
// re-shadow globalThis.TextEncoder with its own non-Uint8Array-producing implementation.
import { TextEncoder, TextDecoder } from "node:util";

globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;

// @astryxdesign/core's compiled output was authored against the classic JSX runtime, where
// React must be in module/global scope even though this project's tsconfig uses the automatic
// "react-jsx" transform. Exposing React globally bridges that gap for the dependency's code
// without affecting how this project's own JSX is compiled.
import React from "react";
globalThis.React = React;

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
