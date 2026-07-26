// vitest.environment.ts — wraps Vitest's built-in "jsdom" environment to fix a realm
// mismatch that otherwise crashes test collection outright.
//
// jsdom's `window` always lives in its own V8 realm (jsdom evaluates it inside an
// internal `vm` context), and Vitest's jsdom `populateGlobal()` unconditionally mirrors
// Uint8Array/ArrayBuffer (and the other TypedArray constructors) from that realm onto
// the outer `globalThis` — see the `LIVING_KEYS` list vitest copies verbatim from
// jsdom/lib/jsdom/living/interfaces.js in its own dist/chunks bundle. After that, every
// `instanceof Uint8Array` check against a value produced by outer-realm/native APIs
// (TextEncoder, Buffer, fs, crypto, ws, pg, ...) fails — including esbuild's own startup
// invariant check (node_modules/esbuild/lib/main.js: `encodeUTF8("") instanceof
// Uint8Array`), which throws the moment esbuild is first loaded to transform any
// TypeScript file. Vitest's "node" environment already re-pins Uint8Array/ArrayBuffer
// after its own vm-context setup for exactly this reason; the "jsdom" environment has no
// equivalent fix.
//
// `NativeUint8Array`/`NativeArrayBuffer` are captured at module load time, before jsdom
// ever runs, so they are guaranteed to be the real, outer-realm constructors. The fix has
// to live here rather than in a setupFile: Vitest resolves and transforms the
// `test.environment` module (this file) *before* calling its `setup()`, so esbuild's
// invariant check first runs — successfully — against this file, while the realm is
// still pristine. By the time `environment.setup()` shadows the globals and vitest goes
// on to transform setupFiles/test files, esbuild is already loaded and cached; a fix
// placed in a setupFile would run too late, since transforming that very setupFile is
// what needs esbuild in the first place.
import { builtinEnvironments } from "vitest/environments";
import type { Environment } from "vitest/environments";

const NativeUint8Array = Uint8Array;
const NativeArrayBuffer = ArrayBuffer;
const jsdomEnvironment = builtinEnvironments.jsdom;

const environment: Environment = {
  name: "fixed-jsdom",
  transformMode: jsdomEnvironment.transformMode,
  async setup(global, options) {
    const result = await jsdomEnvironment.setup(global, options);
    global.Uint8Array = NativeUint8Array;
    global.ArrayBuffer = NativeArrayBuffer;
    return result;
  },
};

export default environment;
