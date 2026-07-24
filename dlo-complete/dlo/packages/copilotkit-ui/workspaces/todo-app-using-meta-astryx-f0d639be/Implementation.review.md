# CEO Review — Implementation.md

> Reviewer: built-in
> Reviewed: 2026-07-24T10:52:26.900Z

## Suggestion 1 — Server functions trust a client-supplied `userId` with no auth layer [severity: high]
**Rationale:** `ListTodosSchema` is `{userId?: uuid, completed?: boolean}`, and m8's server functions validate input then call the orchestrator directly — there is no session, no auth middleware, and no derivation of `userId` from anything server-controlled anywhere in the plan. As written, any client can pass an arbitrary `userId` to `listTodosFn`/`createTodoFn` and read or write another user's data — a textbook IDOR. At the same time, the seed script only ever creates *one* demo user, so nothing in the plan actually exercises multi-user behavior. The plan is straddling "single-user demo" and "multi-user app" without committing to either, which is a scope decision that should be made explicitly, not left implicit in a nullable FK.

**Proposed change:** Pick one and say so in Implementation.md. If this is a single-user MVP (recommended given no auth wave exists): drop `userId` from `ListTodosSchema`/repository signatures entirely and have `getOrchestrator()` resolve the one demo user server-side (e.g. from an `env.ts`-configured `DEMO_USER_ID`), so the client can never assert an identity. Add a line under Wave 3: *"m8 server functions do not accept or trust a client-supplied `userId`; the orchestrator resolves the acting user server-side. Multi-user auth is out of scope for this plan."* If multi-user is actually required, add an m-numbered auth/session module before m7 and change m8's acceptance criteria to require session-derived `userId`, not schema-validated client input.

## Suggestion 2 — Astryx (`@astryx/react`) integration risk isn't retired until Wave 4 [severity: high]
**Rationale:** `@astryx/react` is a new/unfamiliar dependency per the steering note, yet the plan only *configures* it in m5 (Wave 1: exports color tokens + a theme-provider config, never rendered) and doesn't actually mount an `AstryxCard`/`AstryxButton`/`AstryxCheckbox`/`AstryxToast` until m9/m10 in Wave 4 — after 8 other modules (m1–m8) have already been built on the assumption it works. If Astryx's API shape (props, theming contract, provider nesting) doesn't match what m5/m9 assume, you discover it after most of the build is done, and the fix likely touches m5, m9, and m10 simultaneously.

**Proposed change:** In m5's acceptance criteria, change:
`"exported color tokens match seed data hexes... Tailwind build picks up the new tokens"`
to add a real smoke test:
`"a throwaway unit test (or minimal route) imports AstryxThemeProvider, AstryxCard, AstryxButton, AstryxCheckbox, and AstryxToast from @astryx/react and renders them without throwing, confirming the actual component/prop API before Wave 4 begins."`
This surfaces any Astryx surprises in Wave 1, when only m5 needs to be reworked, instead of Wave 4.

## Suggestion 3 — Drag-and-drop reorder UI has no drag library in the dependency list [severity: high]
**Rationale:** m9's prompt requires `TodoList.tsx (renders items, drag-reorder via useReorderTodos)`, but m1's `package.json` dependency list (`@tanstack/react-start, @tanstack/react-router, @tanstack/react-query, react, react-dom, drizzle-orm, pg, zod, @astryx/react, vinxi`) contains no drag-and-drop library (e.g. `@dnd-kit/core`/`@dnd-kit/sortable`). The plan's own stated design principle for Wave 0 is *"package.json with every dependency... so no later module has to add a dependency"* — this is a concrete violation of that principle that will force m9 to either add a new dependency mid-build (breaking the stated build-order contract) or silently drop drag-and-drop and fall back to up/down buttons, which changes what "reorder" means to the user without anyone deciding that.

**Proposed change:** Add `@dnd-kit/core` and `@dnd-kit/sortable` to m1's dependency list:
`"package.json deps: ..., pg, zod, @astryx/react, @dnd-kit/core, @dnd-kit/sortable, vinxi; ..."`
and update m9's prompt to name the library explicitly: `"drag-reorder implemented with @dnd-kit/sortable, calling useReorderTodos on drag end."` If drag-and-drop is actually not essential for the MVP, the cheaper fix is to descope it now — replace "drag-reorder" with "reorder via up/down buttons" in m9 and simplify `reorderTodosSchema`/`reorder()` accordingly, since the deferrable-unique-constraint transactional reorder logic in m6 is meaningfully more complex than the UI it's currently justifying.

## Suggestion 4 — No way to create or manage categories, but the UI implies it [severity: medium]
**Rationale:** m7's orchestrator only exposes `listCategories` (read-only) and m11 seeds exactly 4 fixed categories, but m9's `AddTodoForm.tsx` includes a "category" field and `TodoFilters.tsx` includes "category filter chips" with no corresponding `createCategory`/`deleteCategory` path anywhere in m7/m8. A user opening this app will reasonably expect to add a 5th category and hit a dead end. This isn't necessarily wrong to scope out, but it's currently an undocumented gap rather than a decision.

**Proposed change:** Add an explicit scope line to the Modules section, e.g. under m7 or as a new sentence in the Build Order intro: *"Categories are fixed, seed-only data for this MVP — there is no create/edit/delete-category flow in the UI or orchestrator; `listCategories` is read-only by design."* This costs nothing to implement and removes ambiguity for whoever builds/reviews m9.

## Suggestion 5 — Seed script (m11) is sequenced later than its dependencies require [severity: medium]
**Rationale:** m11 only depends on m2 and m6, yet the plan places it in Wave 4, run "in parallel with m9/m10" — three waves after its actual dependencies are satisfied. Since m11 (`db:seed`) is the cheapest way to sanity-check that the schema and repository layer actually work with real rows, delaying it until Wave 4 means m7 and m8 (Waves 2–3) get built and typechecked against an *unseeded, unverified* database for two full waves, deferring a cheap early signal.

**Proposed change:** Change:
`"Wave 4 — UI (m9, then m10, in parallel with m11). ... In parallel, the seed script (m11) only needs the db layer and repository (m2/m6), so it can be built alongside m9/m10 without waiting on the UI."`
to move m11 into Wave 2:
`"Wave 2 — Data & domain (m6, then m7, in parallel with m11). Once m6 lands, the seed script (m11) can run alongside m7's build, giving the orchestrator and every module after it a populated database to develop and typecheck against instead of an empty one."`

## Suggestion 6 — No deployment target is defined [severity: low]
**Rationale:** The plan covers local dev thoroughly (docker-compose for Postgres, `npm run dev`/`build`) but never states whether this ships anywhere (Vercel, a container, etc.) or is purely a local demo. That's a reasonable scope choice for a todo app, but it should be a stated choice — otherwise "done" is ambiguous and someone will eventually ask "so where does this run in prod?"

**Proposed change:** Add one sentence to the top of Implementation.md: *"Scope: this plan targets a local/dev-only build (`npm run dev` + docker-compose Postgres). Production deployment (hosting, managed Postgres, env-secret management) is out of scope and would require an additional module."*

## Overall Verdict
The structural core of this plan — strict wave-based dependency ordering, a single orchestrator facade, Result/AppError contracts, Zod validation at the boundary — is sound and appropriately scoped for a todo app; it isn't over-built. The real risks are at the edges the plan glossed over: it never commits to a single-user-vs-multi-user identity model even though the schema and server-function signatures behave as if multi-user auth exists (it doesn't), it defers validating the one genuinely novel/risky dependency (Astryx) until three waves after most other code is written, and it specifies a drag-and-drop UI feature without ever adding a drag-and-drop dependency — a concrete, mechanical gap that will break the build order it claims to follow. Fix the auth/userId trust boundary and the missing drag library before build starts, pull the Astryx smoke test and the seed script earlier to convert late, expensive surprises into cheap, early ones, and this plan is ready to execute.