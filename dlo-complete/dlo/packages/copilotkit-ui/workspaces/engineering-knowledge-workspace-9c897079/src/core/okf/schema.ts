// src/core/okf/schema.ts — zod schema for raw OKF YAML frontmatter (Implementation.md m8).
// This is the on-disk frontmatter shape shared by the Git-sync worker and the browser panel, and
// it is deliberately NOT the same shape as `core/types.ts`'s `Provenance`: that type is the
// DB-mapped domain record (`generatedBy`/`reviewedAt`), while OKF's own frontmatter vocabulary is
// `retrievedAt`/`checksum`. `id` is a plain string, not a branded `ConceptId` — this schema must
// stay safe to point at somebody else's OKF bundle, whose ids are not guaranteed to be one of our
// v4 UUIDs. `trust`/`lifecycle` reuse `core/types.ts`'s unions (via their type guards) so the two
// modules can never drift apart on what a legal value is. Unknown top-level keys are preserved
// (`.passthrough()`) rather than stripped, per Database.md's `concept_frontmatter.extra` rationale:
// "Preserving these is what makes the workspace safe to point at somebody else's OKF bundle."
import { z } from "zod";
import type { Lifecycle, TrustLevel } from "../types";
import { isLifecycle, isTrustLevel } from "../types";

const trustLevelSchema: z.ZodType<TrustLevel> = z.custom<TrustLevel>(isTrustLevel, {
  message: "trust must be one of: unverified, machine-confirmed, human-reviewed",
});

const lifecycleSchema: z.ZodType<Lifecycle> = z.custom<Lifecycle>(isLifecycle, {
  message: "lifecycle must be one of: draft, active, deprecated, archived",
});

/**
 * OKF frontmatter provenance block. `checksum` is optional: not every OKF source records one
 * (e.g. hand-authored concepts have no upstream artifact to checksum). `.passthrough()` for the
 * same reason as the top-level schema: a foreign OKF bundle's extra provenance keys (its own
 * `generator`, `model`, `commit`, ...) must survive a round trip, not be rejected or dropped.
 */
export const okfProvenanceSchema = z
  .object({
    source: z.string().min(1, "provenance.source must not be empty"),
    author: z.string().min(1, "provenance.author must not be empty"),
    /** ISO-8601 instant the source content was retrieved or generated. */
    retrievedAt: z.string().min(1, "provenance.retrievedAt must not be empty"),
    checksum: z.string().min(1, "provenance.checksum must not be empty").optional(),
  })
  .passthrough();

export type OkfProvenance = z.infer<typeof okfProvenanceSchema>;

/**
 * The full OKF frontmatter object. `.passthrough()` keeps any key this schema does not model
 * (instead of `zod`'s default of silently stripping it), so a round trip through this app never
 * loses a foreign OKF bundle's custom metadata.
 */
export const okfFrontmatterSchema = z
  .object({
    id: z.string().min(1, "id must not be empty"),
    title: z.string().min(1, "title must not be empty"),
    trust: trustLevelSchema,
    lifecycle: lifecycleSchema,
    provenance: okfProvenanceSchema,
    tags: z.array(z.string().min(1, "tags entries must not be empty")).default([]),
    links: z.array(z.string().min(1, "links entries must not be empty")).default([]),
    /** ISO-8601 instant of the last edit. */
    updatedAt: z.string().min(1, "updatedAt must not be empty"),
  })
  .passthrough();

export type OkfFrontmatter = z.infer<typeof okfFrontmatterSchema>;
