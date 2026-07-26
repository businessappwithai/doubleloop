// src/core/types.ts — the OKF domain unions and record types (Architecture.md "core" §1).
// `TrustLevel` and `Lifecycle` are the pure-domain unions; note they are spelled with hyphens
// and, for `Lifecycle`, four states (`draft | active | deprecated | archived`) — this is what
// Architecture.md's own `core` interface declares and what RESEARCH.md's provenance section
// names, even though Database.md's `trust_level`/`lifecycle_state` Postgres enums use different
// spellings and a five-state `lifecycle_state`. That mismatch is a persistence-mapping concern
// for whichever module reads/writes `concept_frontmatter` (it must translate at the adapter
// boundary); this module stays the pure domain shape and does not silently adopt the DB enum.
import type { ActorId, BundleId, ConceptId } from "./ids";

export type TrustLevel = "unverified" | "machine-confirmed" | "human-reviewed";

const TRUST_LEVELS: readonly TrustLevel[] = ["unverified", "machine-confirmed", "human-reviewed"];

/** Type guard for {@link TrustLevel}; safe on any `unknown`, e.g. a value parsed from JSONB. */
export function isTrustLevel(value: unknown): value is TrustLevel {
  return typeof value === "string" && (TRUST_LEVELS as readonly string[]).includes(value);
}

export type Lifecycle = "draft" | "active" | "deprecated" | "archived";

const LIFECYCLES: readonly Lifecycle[] = ["draft", "active", "deprecated", "archived"];

/** Type guard for {@link Lifecycle}; safe on any `unknown`, e.g. a value parsed from JSONB. */
export function isLifecycle(value: unknown): value is Lifecycle {
  return typeof value === "string" && (LIFECYCLES as readonly string[]).includes(value);
}

/**
 * OKF provenance object (Architecture.md "core" §1). `generatedBy` and `reviewedAt` are
 * nullable rather than optional: absence is a fact about the Concept ("no generator", "never
 * reviewed"), not an unknown field, and every consumer must handle it explicitly.
 */
export interface Provenance {
  readonly source: string;
  readonly author: string;
  readonly generatedBy: string | null;
  /** ISO-8601 instant, or `null` if never reviewed. */
  readonly reviewedAt: string | null;
}

/** Type guard for {@link Provenance}; does not validate `source`/`author` content, only shape. */
export function isProvenance(value: unknown): value is Provenance {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["source"] === "string" &&
    typeof candidate["author"] === "string" &&
    (candidate["generatedBy"] === null || typeof candidate["generatedBy"] === "string") &&
    (candidate["reviewedAt"] === null || typeof candidate["reviewedAt"] === "string")
  );
}

/**
 * A Knowledge Bundle (Database.md `bundles`): a self-contained collection of Concepts and the
 * unit of Git synchronisation. Timestamps are ISO-8601 strings, not `Date`, so this type stays
 * representable as plain JSON without a codec — `Date` construction is an orchestrator/adapter
 * concern per Architecture.md rule 4 ("nothing above the orchestrator knows about ... Date").
 */
export interface Bundle {
  readonly id: BundleId;
  readonly workspaceId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly okfVersion: string;
  readonly defaultTrust: TrustLevel;
  readonly createdBy: ActorId;
  readonly conceptCount: number;
  readonly version: number;
  /** ISO-8601 instant. */
  readonly createdAt: string;
  /** ISO-8601 instant. */
  readonly updatedAt: string;
  /** ISO-8601 instant, or `null` if not soft-deleted. */
  readonly deletedAt: string | null;
}

/**
 * A Concept (Database.md `concepts`): one hierarchical node, one Markdown document. Holds only
 * the stable relational facts — the fluid block/CRDT payload and the YAML frontmatter live in
 * separate tables (and separate domain types owned by later modules).
 */
export interface Concept {
  readonly id: ConceptId;
  readonly bundleId: BundleId;
  readonly parentId: ConceptId | null;
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly sortKey: string;
  readonly depth: number;
  readonly isIndex: boolean;
  readonly childCount: number;
  readonly createdBy: ActorId;
  readonly version: number;
  /** ISO-8601 instant. */
  readonly createdAt: string;
  /** ISO-8601 instant. */
  readonly updatedAt: string;
  /** ISO-8601 instant, or `null` if not soft-deleted. */
  readonly deletedAt: string | null;
}
