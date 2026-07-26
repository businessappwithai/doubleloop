# Engineering Knowledge Workspace

A collaborative, block-based engineering knowledge workspace specialised for Google Cloud's
Open Knowledge Format (OKF): Knowledge Bundles containing hierarchical Concepts (Markdown +
YAML frontmatter), edited in a Lexical block editor, synchronised in real time with Yjs CRDTs,
served by a GraphQL API following Relay conventions over PostgreSQL 17, and exported back to
`.md` files by a Git-synchronisation worker.

See `Architecture.md` for the build contract, `Database.md` for the schema, and
`Implementation.md` for the module-by-module plan. This repository is a strict implementation
of those three documents — nothing in the stack below is substituted.

## Stack

- **Application framework:** [TanStack Start](https://tanstack.com/start) — React 19,
  file-based routing, server functions, Vite.
- **Design system:** [Meta Astryx](https://github.com/facebook/astryx)
  (`@astryxdesign/core`, `@astryxdesign/theme-neutral`) with
  [StyleX](https://stylexjs.com) as the compile-time CSS engine.
- **Editor engine:** [Meta Lexical](https://lexical.dev) — a block-based rich text editor with
  custom `ElementNode`/`DecoratorNode` block types and markdown shortcut transforms.
- **Collaboration:** [Yjs](https://yjs.dev) CRDTs over a dedicated `y-websocket` relay.
- **Data layer:** GraphQL (`graphql-js`) with Relay conventions (`Node` interface, base64
  global ids, cursor `Connection`s), consumed by `react-relay`.
- **Persistence:** PostgreSQL 17, hybrid relational + `JSONB`, `pg` as the driver.

## Getting started

```bash
docker compose up -d postgres      # postgres:17 — see Architecture.md "Deployment Shape"
cp .env.example .env               # fill in DATABASE_URL, COLLAB_WS_URL for your machine
npm install
npm run migrate                    # applies sql/migrations/*.sql in order
npm run relay                      # generates Relay's __generated__ artifacts
npm run dev                        # http://localhost:3000
npm run collab                     # second terminal: ws://localhost:1234
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server for the app (`http://localhost:3000`). |
| `npm run build` | Production build (`dist/client` + `dist/server`, StyleX extracted at compile time). |
| `npm start` | Serves the production build (`vite preview`). |
| `npm run collab` | Starts the Yjs `y-websocket` collaboration relay (`ws://localhost:1234`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run relay` | Runs `relay-compiler` against `schema.graphql`. |
| `npm run schema:emit` | Emits the merged GraphQL SDL to `schema.graphql`. |
| `npm run migrate` | Applies `sql/migrations/*.sql`, in order, additive-only. |
| `npm test` | `vitest run` — the full suite, no `--passWithNoTests`. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:coverage` | Vitest with v8 coverage, thresholds enforced. |
| `npm run verify` | `typecheck` then `test` — the local pre-push gate. |

## Project layout

```
src/
├─ core/            pure domain kernel (ids, cursors, errors, frontmatter, markdown) — no I/O
├─ config/          zod-validated environment configuration
├─ lib/              structured JSON logger
├─ server/          the central orchestrator, ports, GraphQL schema assembly
├─ adapters/        side-effecting implementations of the ports (pg, fs, git, clock, ids)
├─ modules/         one directory per domain module (bundles, concepts, hierarchy, …)
├─ collab-server/   the standalone Yjs websocket relay process
├─ routes/          TanStack Start file-based routes
├─ components/       Astryx-composed UI components
├─ relay/           Relay environment, network layer, optimistic update helpers
└─ styles/          global reset + StyleX theme tokens
tests/               mirrors src/, one test file per source file — see Architecture.md
                     "Testing Strategy" for the exact convention
sql/migrations/      numbered, forward-only SQL migrations
```

## Status

This is the project scaffold (module `m1` of the build plan). The test harness, domain
kernel, persistence layer, GraphQL API, and UI are added by the modules that follow — see
`Implementation.md` for the full dependency graph.
