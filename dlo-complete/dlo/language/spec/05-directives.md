# EML — Directive Reference

Directives are `%%`-prefixed comment lines that carry generator meaning while
staying invisible to Mermaid renderers. Only `%%hook` is parsed by the currently
shipped parser; the rest are the documented, reserved extension surface — they
are renderer-safe today and adopted by the generator incrementally.

All directive keywords are reserved: `%%meta`, `%%hook`, `%%entity`, `%%field`,
`%%enum`, `%%index`, `%%rule`, `%%guard`, `%%trigger`, `%%workflow`.

---

## `%%meta` — document / section metadata

```
%%meta <key>: <value>
```

| Key | Meaning |
|-----|---------|
| `name` | Human name of the model/section |
| `kind` | `erd` \| `rules` \| `workflow` (classifies the following diagram) |
| `version` | Semantic version of the model |
| `entity` | Default entity binding for the section |
| `stack` | Target stack hint (`tanstack-start-nestjs` \| `openui5-odatav4`) |

```
%%meta name: CRM Core
%%meta kind: rules
%%meta version: 1.0.0
```

## `%%hook` — lifecycle handler binding *(shipped)*

```
%%hook <type> <handlerName> on <Entity>[<params>]
```

Regex (from `hook-parser.ts`):

```
%%hook\s+(\w+)\s+(\w+)\s+on\s+(\w+)(\[(?:field:\s*\w+(?:\s*,\s*field:\s*\w+)*)?\])?
```

- `type` — one of the 13 hook types (see `03-workflows.md`).
- `params` — optional `[field: a, field: b]`.

```
%%hook beforeCreate hashPassword on User
%%hook beforeCreate generateSlug on Post[field: slug]
```

## `%%entity` — entity-level metadata

```
%%entity <Name> <key>: <value>
```

| Key | Meaning |
|-----|---------|
| `prefix` | `bus` \| `sys` table prefix |
| `audited` | `true` \| `false` — emit audit trail |
| `softDelete` | `true` \| `false` — use `deleted_at` |
| `label` | UI display label |
| `icon` | UI icon name |

```
%%entity Order audited: true
%%entity Account prefix: bus
```

## `%%field` — extended field metadata

```
%%field <Entity>.<attr> <key>: <value>
```

| Key | Meaning |
|-----|---------|
| `enum` | Reference a `%%enum` for allowed values |
| `ui` | Control override (select, textarea, switch, …) |
| `default` | Default value |
| `min` / `max` | Numeric or length bounds |
| `help` | Field help text |
| `format` | Display/validation format |

```
%%field Order.status enum: OrderStatus
%%field Product.price min: 0
%%field User.bio ui: textarea
```

## `%%enum` — named enumeration

```
%%enum <Name>: <value1>, <value2>, ...
```

Reusable by `%%field enum:` and by state-workflow states.

```
%%enum OrderStatus: draft, submitted, approved, shipped, cancelled
%%enum Priority: low, medium, high, urgent
```

## `%%index` — database index

```
%%index <Entity>(<attr>[, <attr>...]) [unique]
```

```
%%index Contact(email) unique
%%index Order(company_id, status)
```

## `%%rule` — bind a decision flow

```
%%rule <name> on <Entity> event: <lifecycle> priority: <n>
```

Ties a business-rules section to an entity + lifecycle event; `priority` orders
multiple rules.

```
%%rule pricing on Order event: beforeCreate priority: 10
```

## `%%guard` — RBAC guard

```
%%guard <roleExpr> on <Entity>.<op>
```

`roleExpr` uses `role:<name>` with `|` for OR. Integrates with core
`rbac.types`.

```
%%guard role:admin on Order.delete
%%guard role:sales|manager on Deal.update
```

## `%%trigger` — event / schedule source

```
%%trigger <source> -> <handler> on <Entity>
```

`source` forms: `cron:<expr>`, `webhook:<name>`, `message:<topic>`.

```
%%trigger cron:0 0 * * * -> expireQuotes on Quote
%%trigger webhook:payment -> markPaid on Order
```

## `%%workflow` — name & classify a workflow

```
%%workflow <name> entity: <Entity> kind: <hook|state|saga>
```

```
%%workflow OrderFulfilment entity: Order kind: state
%%workflow SignupFlow entity: User kind: hook
```
