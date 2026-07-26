// vitest.global-setup.ts — runs once, before Vitest's esbuild-based test collection.
// esbuild's invariant check (run while collecting test files) rejects any TextEncoder
// that does not produce a true Uint8Array instance. jsdom's own TextEncoder fails that
// check, and vitest.setup.ts's per-file polyfill runs too late — after collection has
// already happened. Installing the Node polyfill here, in globalSetup, runs it before
// collection starts.
import { TextEncoder, TextDecoder } from "node:util";

export default function setup() {
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;
}
