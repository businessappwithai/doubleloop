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
// `loadDotEnvIntoProcess` exists because Vite's own `.env` handling only ever reaches
// `import.meta.env`, and only for `VITE_`-prefixed keys — while every server module here
// (`src/config/config.ts`, via `loadConfig(process.env)`) reads unprefixed variables off
// `process.env`. Without this, `vite dev` and `vite preview` start fine and then fail the first
// GraphQL request with `ConfigError: Invalid configuration for INSTANCE_ID: Required`. The dev and
// preview servers run the SSR entry in *this* process, so seeding `process.env` here is what makes
// `.env` reach it. Deliberately non-overriding: a variable already present in the real environment
// always wins, so a container's or CI's configuration is never silently replaced by a checked-out
// `.env`. Local-development plumbing only — in production the platform supplies the environment
// and `.env` does not exist.
import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { astryxStylex } from "@astryxdesign/build/vite";
import { fileURLToPath } from "node:url";

function loadDotEnvIntoProcess(mode: string, root: string): void {
  // "" as the prefix filter: load every key, not just VITE_ — the server needs DATABASE_URL et al.
  for (const [key, value] of Object.entries(loadEnv(mode, root, ""))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export default defineConfig(({ mode }) => {
  loadDotEnvIntoProcess(mode, fileURLToPath(new URL(".", import.meta.url)));

  return {
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
  };
});
