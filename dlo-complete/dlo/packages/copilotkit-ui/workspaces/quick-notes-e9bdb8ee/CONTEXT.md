# Steering Notes — Quick Notes

## [2026-07-23T10:54:29]

For the UI components module: the component tests fail with a null React dispatcher because the tanstackStart() vite plugin breaks vitest. Fix: create vitest.config.ts (vitest prefers it over vite.config.ts) containing ONLY the react() plugin plus test settings (jsdom, globals, setupFiles), and leave vite.config.ts as-is for dev/build. Do not rewrite the components.
