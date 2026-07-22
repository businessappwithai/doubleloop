# EML Overview

**ERDwithAI Modeling Language (EML)**, version 1.0.0 — a Mermaid-based language
for describing an application's data model, business rules, and business
workflows as one artifact.

## Design goals

1. **One language, three concerns.** Structure (ERD), decision logic (rules),
   and process (workflows) are expressed with a shared, coherent syntax.
2. **Valid Mermaid.** Every EML document renders as-is in any Mermaid viewer.
   Nothing is lost when a stakeholder opens the file in a diagram tool.
3. **Machine-readable and standalone.** The entire language is defined in
   `language/erdwithai-language.json`, independent of any single parser, so the
   generator (and future tooling) reads one authoritative contract.
4. **Renderer-safe extensibility.** Extra semantics ride on `%%` comments, which
   Mermaid ignores. Adding generator meaning never breaks rendering.

## Document model

An EML document is a UTF-8 text file containing one or more **sections**. Each
section opens with a Mermaid diagram keyword:

| Opening keyword | Section |
|-----------------|---------|
| `erDiagram` | ERD |
| `flowchart` / `graph` | Business rules **or** workflow (disambiguated below) |
| `stateDiagram-v2` | Workflow (state-machine form) |

A single file may hold several sections separated by blank lines.

### Comments and directives

- A line starting with `%%` is a Mermaid comment.
- A **plain** comment (`%% notes...`) is documentation, ignored by everyone.
- A **directive** comment begins with a reserved keyword and carries meaning to
  the generator while staying invisible to renderers:

  ```
  %%meta     %%hook     %%entity    %%field    %%enum
  %%index    %%rule     %%guard     %%trigger  %%workflow
  ```

  Only `%%hook` is parsed by the currently shipped parser; the rest form the
  documented EML extension surface (see `05-directives.md`).

### Disambiguating flowchart vs. rules vs. workflow

A `flowchart` is read as a **business-rules decision flow** when:

- it is preceded by `%%meta kind: rules`, **or**
- it contains only decision/expression/function/io node shapes and **no**
  `%%hook` directives.

Otherwise a `flowchart` is read as a **workflow**. A `stateDiagram-v2` is always
a workflow (its states map to a status enum for the bound entity).

## The pipeline

```
ERD section        → MermaidParser        → Entity[] + Relationship[] → migrations, DTOs, services, controllers, UI
Rules section      → flowchart parser      → convertToJdm            → GoRules JDM decision graph
Workflow section   → hook parser / states  → HookDefinition[] / enum  → service lifecycle wiring, status transitions
```

Reference implementations:

- `packages/generator/src/parsers/mermaid.parser.ts`
- `packages/web/src/lib/mermaid-flowchart-parser.ts`
- `packages/web/src/lib/jdm-converter.ts`
- `packages/web/src/lib/workflow/hook-parser.ts`

## Naming conventions

| Element | Rule | Recommended case |
|---------|------|------------------|
| Entity name | `^[a-zA-Z][a-zA-Z0-9_]*$` | `PascalCase` |
| Attribute name | `^[a-zA-Z][a-zA-Z0-9_]*$` | `snake_case` |
| Hook / handler | `^[a-zA-Z_][a-zA-Z0-9_]*$` | `camelCase` |
| Enum name | `^[A-Za-z][A-Za-z0-9_]*$` | `PascalCase` |
| Node id (flows) | `^[A-Za-z_][A-Za-z0-9_]*$` | short `A`, `B`, … |

Continue with:

- [`01-erd.md`](01-erd.md) — Entity Relationship Diagrams
- [`02-business-rules.md`](02-business-rules.md) — Business rules
- [`03-workflows.md`](03-workflows.md) — Workflows
- [`04-types-and-modifiers.md`](04-types-and-modifiers.md) — Types, modifiers, cardinalities
- [`05-directives.md`](05-directives.md) — Directive reference
