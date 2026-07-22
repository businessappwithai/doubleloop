/**
 * ERDwithAI Modeling Language (EML)
 * ---------------------------------
 * Standalone, Mermaid-based language for describing an application's
 * Entity Relationship Diagram (ERD), its business rules, and its business
 * workflows in one artifact.
 *
 * The canonical, machine-readable definition lives in
 * `language/erdwithai-language.json`. This module is a typed loader/accessor
 * so the generator application (and any tooling) can read the language
 * definition without re-parsing the JSON by hand.
 *
 * @example
 * ```ts
 * import { loadLanguageDefinition, normalizeType, cardinalityKind } from "../language";
 *
 * const def = loadLanguageDefinition();
 * normalizeType("varchar");      // "string"
 * cardinalityKind("||--o{");     // "oneToMany"
 * isHookType("beforeCreate");    // true
 * ```
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types describing the shape of erdwithai-language.json
// ---------------------------------------------------------------------------

export type CanonicalType =
  | "string"
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "json";

export type CardinalityKind = "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";

export type HookType =
  | "beforeCreate"
  | "afterCreate"
  | "beforeUpdate"
  | "afterUpdate"
  | "beforeDelete"
  | "afterDelete"
  | "beforeQuery"
  | "afterQuery"
  | "customValidate"
  | "beforeRead"
  | "afterRead"
  | "beforeList"
  | "afterList";

export type JdmNodeRole =
  | "inputNode"
  | "outputNode"
  | "switchNode"
  | "functionNode"
  | "expressionNode";

export interface LanguageDefinition {
  $schema: string;
  $id: string;
  language: {
    id: string;
    name: string;
    abbreviation: string;
    version: string;
    basedOn: string;
    mermaidCompatibility: string;
    description: string;
    fileExtensions: string[];
    encoding: string;
    caseSensitivity: Record<string, string>;
    purpose: string[];
  };
  document: Record<string, unknown>;
  sections: Record<string, unknown>;
  types: {
    description: string;
    canonical: CanonicalType[];
    map: Record<string, CanonicalType>;
    semanticHints: Record<string, string>;
    default: CanonicalType;
  };
  modifiers: {
    description: string;
    map: Record<string, { meaning: string; effects: string[] }>;
    defaults: Record<string, string>;
  };
  cardinalities: {
    description: string;
    glyphReference: Record<string, string>;
    map: Array<{ operator: string; kind: CardinalityKind; example: string }>;
  };
  hooks: {
    description: string;
    types: Array<{ type: HookType; phase: string; op: string; purpose: string }>;
    directive: { pattern: string; regex: string; paramForms: string[] };
  };
  ruleNodes: {
    description: string;
    map: Array<{
      shape: string;
      delimiters: string;
      jdmType: string;
      role: string;
      example: string;
      resolution?: string;
    }>;
  };
  workflowConstructs: Record<string, unknown>;
  directives: {
    description: string;
    reserved: Array<{ keyword: string; form: string; purpose: string; examples: string[] }>;
  };
  grammar: Record<string, string>;
  generatorContract: Record<string, unknown>;
  conformance: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Absolute path to the canonical language definition file. */
export const LANGUAGE_DEFINITION_PATH = (() => {
  // Resolve relative to this module so it works from source and from dist.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "erdwithai-language.json");
})();

let cached: LanguageDefinition | null = null;

/**
 * Load and cache the canonical EML definition from disk.
 * @param force - bypass the in-memory cache and re-read the file.
 */
export function loadLanguageDefinition(force = false): LanguageDefinition {
  if (cached && !force) return cached;
  const raw = readFileSync(LANGUAGE_DEFINITION_PATH, "utf-8");
  cached = JSON.parse(raw) as LanguageDefinition;
  return cached;
}

// ---------------------------------------------------------------------------
// Convenience accessors (thin helpers over the definition data)
// ---------------------------------------------------------------------------

/** Normalize an attribute type alias to its canonical type (default: "string"). */
export function normalizeType(rawType: string): CanonicalType {
  const def = loadLanguageDefinition();
  const key = (rawType || "").toLowerCase().replace(/\(\d+\)/, "").trim();
  return def.types.map[key] ?? def.types.default;
}

/** Resolve a Mermaid ER relationship operator to a cardinality kind, or null. */
export function cardinalityKind(operator: string): CardinalityKind | null {
  const def = loadLanguageDefinition();
  const found = def.cardinalities.map.find((c) => c.operator === operator);
  return found ? found.kind : null;
}

/** All valid lifecycle hook types. */
export function hookTypes(): HookType[] {
  return loadLanguageDefinition().hooks.types.map((h) => h.type);
}

/** Type guard: is the given string a valid hook type? */
export function isHookType(value: string): value is HookType {
  return hookTypes().includes(value as HookType);
}

/** All reserved directive keywords (e.g. "%%hook", "%%enum"). */
export function reservedDirectives(): string[] {
  return loadLanguageDefinition().directives.reserved.map((d) => d.keyword);
}

/** Language version string, e.g. "1.0.0". */
export function languageVersion(): string {
  return loadLanguageDefinition().language.version;
}

export default loadLanguageDefinition;
