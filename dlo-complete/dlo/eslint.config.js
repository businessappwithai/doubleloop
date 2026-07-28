/**
 * eslint.config.js
 * The flat config ESLint 9 requires. Until this existed, `pnpm lint` could not
 * run at all ("ESLint couldn't find an eslint.config.js file"), so the declared
 * eslint-plugin-boundaries dependency was enforcing nothing and the dependency
 * rule in CLAUDE.md was documentation rather than a check.
 *
 * The layering rule it enforces:
 *   core ← journal ← kernel ← {scheduler, exit-clauses} ← adapters-* ← ui
 * No rightward imports. A package may import from its own layer's left, never
 * its right — that is what keeps @dlo/core free of runtime dependencies and
 * keeps the UI out of the pure library layers.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Globals for plain .js/.mjs files (build scripts, next.config.js). TypeScript
 * files get theirs from tsc, which is why no-undef is switched off for them —
 * ESLint cannot see type declarations and would report every DOM and Node
 * global as undefined.
 */
const SCRIPT_GLOBALS = {
  process: "readonly",
  console: "readonly",
  URL: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

/** Layers, left (most depended-upon) to right. */
const LAYERS = [
  { type: "core", pattern: "packages/core/**" },
  { type: "language", pattern: "language/**" },
  { type: "journal", pattern: "packages/journal/**" },
  { type: "kernel", pattern: "packages/kernel/**" },
  { type: "scheduler", pattern: "packages/scheduler/**" },
  { type: "exit-clauses", pattern: "packages/exit-clauses/**" },
  { type: "plan-schema", pattern: "packages/plan-schema/**" },
  { type: "erd", pattern: "packages/erd/**" },
  { type: "adapters", pattern: "packages/adapters-*/**" },
  { type: "db-service", pattern: "packages/db-service/**" },
  { type: "ui", pattern: "packages/copilotkit-ui/**" },
];

/** What each layer is allowed to import. Anything unlisted is forbidden. */
const ALLOWED = {
  core: [],
  language: ["core"],
  journal: ["core"],
  kernel: ["core", "journal"],
  scheduler: ["core", "journal", "kernel"],
  "exit-clauses": ["core", "journal", "kernel"],
  "plan-schema": ["core"],
  erd: ["core", "language"],
  adapters: ["core", "journal", "kernel", "scheduler", "exit-clauses", "plan-schema"],
  "db-service": ["core"],
  ui: [
    "core",
    "language",
    "journal",
    "kernel",
    "scheduler",
    "exit-clauses",
    "plan-schema",
    "erd",
    "adapters",
  ],
};

export default tseslint.config(
  {
    // Generated application workspaces are evidence of pipeline runs, not our
    // source: they have their own toolchains and must never fail our lint.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.output/**",
      "**/coverage/**",
      "packages/copilotkit-ui/workspaces/**",
      "packages/copilotkit-ui/public/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build scripts and config files: Node globals, no type information.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: SCRIPT_GLOBALS },
  },
  {
    files: ["**/*.{ts,tsx}"],
    // tsc already proves every identifier resolves, and it can see the DOM and
    // Node type declarations that ESLint cannot.
    rules: { "no-undef": "off" },
  },
  {
    // React rules, and the plugin the UI's inline disable comments refer to —
    // an unregistered rule name in a disable comment is itself an ESLint error.
    files: ["packages/copilotkit-ui/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": LAYERS.map(({ type, pattern }) => ({ type, pattern, mode: "full" })),
      "boundaries/include": ["packages/**/*.ts", "packages/**/*.tsx", "language/**/*.ts"],
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: Object.entries(ALLOWED).map(([from, allow]) => ({
            from: [from],
            allow: [from, ...allow],
          })),
        },
      ],
      // The codebase deliberately uses `any` at the orchestrator's JSON seams
      // (persisted pipeline state, plan documents). Flagging every one of those
      // would bury real findings, so it is a warning, not an error.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // tsconfig's noUnusedLocals already covers this more accurately.
      "no-unused-vars": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Tests legitimately reach for loose typing and fixtures.
    files: ["**/__tests__/**/*.ts", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  }
);
