# EML — Types, Modifiers & Cardinalities

The authoritative maps live in `language/erdwithai-language.json`
(`types`, `modifiers`, `cardinalities`). This page documents them.

## Attribute types

Types are written before the attribute name. Aliases normalize to a **canonical
type**; canonical types drive TypeScript, Zod, SQL/Kysely, OData EDM, and UI
control mapping in the generator. Unknown types default to `string`.

### Canonical types

`string` · `text` · `integer` · `decimal` · `boolean` · `date` · `datetime` · `json`

### Alias → canonical map

| Canonical | Aliases |
|-----------|---------|
| `string` | `string`, `varchar`, `char`, `uuid`, `guid`, `id`, `email`, `url`, `phone`, `password`, `color` |
| `text` | `text`, `longtext` |
| `integer` | `int`, `integer`, `bigint`, `smallint` |
| `decimal` | `number`, `decimal`, `float`, `double`, `money`, `amount` |
| `boolean` | `bool`, `boolean` |
| `date` | `date` |
| `datetime` | `datetime`, `timestamp`, `time` |
| `json` | `json`, `jsonb`, `object`, `array` |

### Semantic hint aliases

These normalize to a base type but carry UI/validation intent the generator may
honor (via naming or `%%field`):

| Alias | Base | Intent |
|-------|------|--------|
| `email` | string | email input, email validation |
| `url` | string | url input |
| `password` | string | password input, min length |
| `phone` | string | tel input |
| `color` | string | color picker |
| `uuid` | string | UUID key |

### Length

Attach an optional length to the type in parentheses:

```
string(120) display_name    → maxLength = 120
varchar(40) code
```

## Modifiers

Bare trailing tokens on an attribute. Case-insensitive. Unknown modifiers are
ignored.

| Modifier | Alias | Effect |
|----------|-------|--------|
| `PK` | — | Primary key: `unique`, generator-managed, sets `entity.primaryKey` |
| `FK` | — | Foreign key: reference column |
| `UK` | `UNIQUE` | Unique constraint: `unique = true` |
| `OPTIONAL` | `NULL` | Nullable: `required = false` |

**Defaults:** `required = true` unless `OPTIONAL`/`NULL`/`PK`;
`unique = false` unless `UK`/`UNIQUE`/`PK`.

## Relationship cardinalities

Mermaid ER operators. The left/right glyphs encode multiplicity; EML maps the
operator to a cardinality **kind** and infers the FK side.

### Glyph reference

| Glyph | Meaning |
|-------|---------|
| `\|\|` | exactly one |
| `\|o` / `o\|` | zero or one |
| `}o` / `o{` | zero or many |
| `}\|` / `\|{` | one or many |

### Operator → kind

| Operator | Kind |
|----------|------|
| `\|\|--\|\|` | `oneToOne` |
| `\|\|--o{` | `oneToMany` |
| `\|\|--\|{` | `oneToMany` |
| `}o--\|\|` | `manyToOne` |
| `}\|--\|\|` | `manyToOne` |
| `}o--o{` | `manyToMany` |
| `}\|--\|{` | `manyToMany` |
| `\|o--o\|` | `oneToOne` |

Foreign key derivation: `snake_case(targetEntity)` minus any `bus_` prefix, plus
`_id` (e.g. `Company` → `company_id`).
