// src/features/frontmatter/fields.ts — declarative descriptors for the OKF frontmatter form
// (Implementation.md m20). FrontmatterPanel.tsx renders from these instead of hand-wiring one
// block of JSX per field, so a new free-text frontmatter field is one new entry here rather than
// a new render branch. Trust/lifecycle options are declared here (not re-derived from
// core/types.ts's private TRUST_LEVELS/LIFECYCLES arrays, which are not exported) with their own
// display labels, since the domain union's hyphenated values ("machine-confirmed") are not
// themselves fit to show a user.
import type { Lifecycle, TrustLevel } from "../../core/types";
import type { FieldIssue, FrontmatterTextFieldKey } from "./form-state";

export interface FrontmatterFieldOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
}

export interface FrontmatterTextFieldDescriptor {
  readonly key: FrontmatterTextFieldKey;
  readonly label: string;
  readonly helpText: string;
  readonly kind: "text";
  readonly isOptional: boolean;
}

/** The free-text fields of the panel, in render order. */
export const TEXT_FIELDS: readonly FrontmatterTextFieldDescriptor[] = [
  {
    key: "title",
    label: "Title",
    helpText: "The concept's display title.",
    kind: "text",
    isOptional: false,
  },
  {
    key: "provenance.source",
    label: "Source",
    helpText: "Where this concept's content originated.",
    kind: "text",
    isOptional: false,
  },
  {
    key: "provenance.author",
    label: "Author",
    helpText: "Who produced this concept's content.",
    kind: "text",
    isOptional: false,
  },
  {
    key: "provenance.retrievedAt",
    label: "Retrieved at",
    helpText: "ISO-8601 instant the source content was retrieved or generated.",
    kind: "text",
    isOptional: false,
  },
  {
    key: "provenance.checksum",
    label: "Checksum",
    helpText: "Integrity checksum of the upstream artifact, if one exists.",
    kind: "text",
    isOptional: true,
  },
];

/** In `TrustLevel` order — `unverified` first is the safest default reading. */
export const TRUST_OPTIONS: readonly FrontmatterFieldOption<TrustLevel>[] = [
  { value: "unverified", label: "Unverified" },
  { value: "machine-confirmed", label: "Machine-confirmed" },
  { value: "human-reviewed", label: "Human-reviewed" },
];

/** In `Lifecycle` order. */
export const LIFECYCLE_OPTIONS: readonly FrontmatterFieldOption<Lifecycle>[] = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "deprecated", label: "Deprecated" },
  { value: "archived", label: "Archived" },
];

/** The first {@link FieldIssue} whose `field` matches `key`, if any. */
export function findFieldIssue(issues: readonly FieldIssue[], key: string): FieldIssue | undefined {
  return issues.find((issue) => issue.field === key);
}
