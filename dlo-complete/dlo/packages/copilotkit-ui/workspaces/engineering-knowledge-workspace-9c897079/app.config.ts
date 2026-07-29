// app.config.ts — the project's Vite config, passed explicitly via `--config app.config.ts`
// (this TanStack Start release line has no `app.config.ts` convention of its own; it
// is driven entirely by a `tanstackStart()` Vite plugin, so this file plays that role under
// the name the build plan assigned it). Also the only place the StyleX/Astryx compile-time
// CSS plugin is wired in (Architecture.md "Technology Choices": StyleX is the CSS engine,
// driven through @astryxdesign/build). Every later module imports StyleX (`stylex.create` /
// `stylex.defineVars`) trusting that this plugin is already registered — do not duplicate
// the wiring elsewhere.
//
// The server entry is named `src/ssr.tsx`, not the framework's default lookup name
// (`src/server.tsx`), so `server.entry` below must point at it explicitly — see ssr.tsx's
// own header comment for why the file keeps that name.
//
// `viteReact`'s `babel.plugins: ["relay"]` (m21) compiles every `graphql` tagged template in
// `.ts`/`.tsx` sources into a `require()` of the artifact `relay-compiler` (`npm run relay`)
// emits under `src/__generated__/` — `react-relay`'s own `graphql` export is a stub that throws
// "Unexpected invocation at runtime" unless this transform runs first. No module before m21 used
// a `graphql` tag from a React component (m7-m15's SDL fragments are plain `.graphql`/hand-written
// resolver files, not Relay client documents), so this is the first place that wiring is needed.
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { astryxStylex } from "@astryxdesign/build/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    ...astryxStylex(),
    tanstackStart({
      server: { entry: "ssr" },
    }),
    viteReact({ babel: { plugins: ["relay"] } }),
  ],
});
