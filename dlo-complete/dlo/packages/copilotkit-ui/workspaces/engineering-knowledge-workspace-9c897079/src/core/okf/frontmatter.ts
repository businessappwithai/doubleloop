// src/core/okf/frontmatter.ts — parse/serialize the raw OKF YAML frontmatter block
// (Implementation.md m8). Operates purely on YAML text; splitting that block out of a full
// Markdown document is `markdown-document.ts`'s job, not this module's. `yaml`'s `uniqueKeys`
// check (on by default, passed explicitly here for intent) is what makes a duplicate frontmatter
// key a parse-time `YAMLParseError` with `code === "DUPLICATE_KEY"` rather than a silently
// last-write-wins object — that failure is re-labelled into its own `ValidationError` reason so
// callers can distinguish "your YAML is corrupt" from "you have a genuine duplicate key" in the UI.
import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from "yaml";
import { ValidationError } from "../errors";
import { okfFrontmatterSchema, type OkfFrontmatter } from "./schema";

const YAML_PARSE_OPTIONS = { uniqueKeys: true, strict: true, version: "1.2" } as const;
const YAML_STRINGIFY_OPTIONS = { sortMapEntries: false, version: "1.2" } as const;

/**
 * Parses a raw OKF frontmatter YAML block (without the `---` fences) into a typed, validated
 * {@link OkfFrontmatter}. Throws `ValidationError` — with `details.reason` set to
 * `"frontmatter.duplicateKey"` for a duplicate mapping key, `"frontmatter.malformedYaml"` for any
 * other YAML syntax error, or `"frontmatter.invalid"` (with `details.issues`, one per failed
 * field) when the YAML parses but does not match the OKF frontmatter shape.
 */
export function parseFrontmatter(raw: string): OkfFrontmatter {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw, YAML_PARSE_OPTIONS);
  } catch (err) {
    if (err instanceof YAMLParseError && err.code === "DUPLICATE_KEY") {
      throw new ValidationError("frontmatter contains a duplicate key", {
        details: { reason: "frontmatter.duplicateKey", yamlMessage: err.message },
        cause: err,
      });
    }
    throw new ValidationError("frontmatter is not valid YAML", {
      details: {
        reason: "frontmatter.malformedYaml",
        yamlMessage: err instanceof Error ? err.message : String(err),
      },
      cause: err,
    });
  }

  const result = okfFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError("frontmatter failed validation", {
      details: {
        reason: "frontmatter.invalid",
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Rebuilds `value` as a new object with `knownKeys` first (in the given order, skipped if
 * absent), then any remaining keys sorted alphabetically. Used to give both the frontmatter
 * object and its nested `provenance` object the same "modelled fields, then passthrough extras"
 * ordering, so serialization is deterministic regardless of the original key order.
 */
function withStableKeyOrder(
  value: Record<string, unknown>,
  knownKeys: readonly string[],
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of knownKeys) {
    if (value[key] !== undefined) {
      ordered[key] = value[key];
    }
  }
  const extraKeys = Object.keys(value)
    .filter((key) => !knownKeys.includes(key))
    .sort();
  for (const key of extraKeys) {
    ordered[key] = value[key];
  }
  return ordered;
}

const PROVENANCE_KEYS = ["source", "author", "retrievedAt", "checksum"] as const;
const FRONTMATTER_KEYS = [
  "id",
  "title",
  "trust",
  "lifecycle",
  "provenance",
  "tags",
  "links",
  "updatedAt",
] as const;

/**
 * Serializes {@link OkfFrontmatter} back into a YAML block (without `---` fences), in a fixed
 * key order (the modelled fields first, any passthrough keys after in alphabetical order) so that
 * serializing the same value always produces byte-identical output regardless of the original
 * file's key order.
 */
export function serializeFrontmatter(fm: OkfFrontmatter): string {
  const ordered = withStableKeyOrder(fm, FRONTMATTER_KEYS);
  ordered["provenance"] = withStableKeyOrder(fm.provenance, PROVENANCE_KEYS);
  return stringifyYaml(ordered, YAML_STRINGIFY_OPTIONS);
}
