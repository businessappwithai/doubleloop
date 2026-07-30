// src/core/global-id.ts — Relay Global Object Identification (Architecture.md "core" §1 /
// "GraphQL conventions (Relay, mandated)"; Implementation.md m7). A global id is the opaque
// base64 encoding of `"TypeName:localId"`. `NODE_TYPES` is the single source of truth for which
// GraphQL types implement `Node` (Bundle, Concept — Architecture.md's SDL excerpt); decoding
// rejects anything outside it so a resolver can never be asked to dispatch to an unknown module.
// Encoding/decoding uses Node's `Buffer`: this file is only ever evaluated server-side (module
// resolvers, `toGlobalId` call sites) — per the Architecture layering rule, `app/routes,
// app/components` depend on Relay + Astryx only, never on `core` directly — so there is no
// browser-bundle constraint pulling this back to a `Buffer`-free implementation. Imported
// explicitly from "node:buffer" rather than used as an ambient global: tsconfig.json's
// `types: ["vite/client"]` does not include "node", so the global `Buffer` declaration from
// `@types/node` is not in scope.
import { Buffer } from "node:buffer";
import { ValidationError } from "./errors";

/** Every GraphQL type that implements the `Node` interface. */
export const NODE_TYPES = ["Bundle", "Concept"] as const;

export type NodeTypeName = (typeof NODE_TYPES)[number];

export interface DecodedGlobalId {
  readonly typeName: NodeTypeName;
  readonly localId: string;
}

function isNodeTypeName(value: string): value is NodeTypeName {
  return (NODE_TYPES as readonly string[]).includes(value);
}

/** Strict base64 alphabet check — rejects the inputs Node's lenient `Buffer.from` would silently mangle. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Encodes `typeName` and `localId` as an opaque Relay global id: `base64("TypeName:localId")`. */
export function toGlobalId(typeName: NodeTypeName, localId: string): string {
  return Buffer.from(`${typeName}:${localId}`, "utf8").toString("base64");
}

/**
 * Decodes a global id produced by {@link toGlobalId}. Throws `ValidationError` with message
 * `'globalId.malformed'` on non-base64 input, a missing `:` separator, an empty type or local id,
 * or a type name outside {@link NODE_TYPES}.
 */
export function fromGlobalId(id: string): DecodedGlobalId {
  if (typeof id !== "string" || id.length === 0 || !BASE64_PATTERN.test(id)) {
    throw malformed(id, "not valid base64");
  }

  const decoded = Buffer.from(id, "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    throw malformed(id, "missing ':' separator");
  }

  const typeName = decoded.slice(0, separatorIndex);
  const localId = decoded.slice(separatorIndex + 1);
  if (typeName.length === 0 || localId.length === 0) {
    throw malformed(id, "empty type or local id");
  }
  if (!isNodeTypeName(typeName)) {
    throw malformed(id, `unknown node type "${typeName}"`);
  }

  return { typeName, localId };
}

function malformed(id: string, reason: string): ValidationError {
  return new ValidationError("globalId.malformed", { details: { id, reason } });
}

/**
 * Decodes a Relay global id and returns its local id, asserting the encoded type first.
 *
 * Every GraphQL argument typed `ID!` carries a *global* id — that is what the client holds, because
 * it is what `Node.id` returns. Passing one straight to `asConceptId`/`asBundleId` therefore fails
 * with "must be a v4 UUID" against the base64 string, and the field is unusable from any Relay
 * client. Several resolvers did exactly that (`conceptDocument`, `saveConceptDocument`,
 * `search`, `gitSyncRuns`, `syncBundle`), so those fields could only ever be called with a raw
 * uuid no client ever has.
 *
 * Throws `ValidationError('globalId.wrongType')` when the id decodes to a different node type —
 * a `Bundle` id passed where a `Concept` is expected is a caller bug, not a lookup miss.
 */
export function localIdOfType(id: string, expected: NodeTypeName): string {
  const decoded = fromGlobalId(id);
  if (decoded.typeName !== expected) {
    throw new ValidationError("globalId.wrongType", {
      details: { id, expected, actual: decoded.typeName },
    });
  }
  return decoded.localId;
}
