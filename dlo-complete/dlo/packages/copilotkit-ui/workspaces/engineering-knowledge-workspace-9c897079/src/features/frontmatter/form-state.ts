// src/features/frontmatter/form-state.ts — pure reducer over the OKF frontmatter edit form
// (Implementation.md m20). Every mutator (setField/addTag/removeTag/setTrust/setLifecycle)
// takes a FrontmatterFormState and returns a new one with `issues` recomputed by re-running
// validate() against the OKF zod schema (schema.ts) — the same schema the Git-sync worker and
// the frontmatter parser use (frontmatter.ts), so the panel can never accept a shape that would
// later fail to round-trip through serializeFrontmatter/parseFrontmatter. `checksum` is modelled
// on the draft as `""` meaning "absent": the schema's `.optional()` + `.min(1)` combination has
// no way to represent "the user cleared this field" as a string, so `""` is translated to "key
// omitted" in buildCandidate before validation/toFrontmatter, never sent through as an empty
// string (which the schema would reject).
import { okfFrontmatterSchema, type OkfFrontmatter } from "../../core/okf/schema";
import type { Lifecycle, TrustLevel } from "../../core/types";

/** The frontmatter fields this panel edits as free text (trust/lifecycle/tags have their own actions). */
export type FrontmatterTextFieldKey =
  | "title"
  | "provenance.source"
  | "provenance.author"
  | "provenance.retrievedAt"
  | "provenance.checksum";

export interface FrontmatterProvenanceDraft {
  readonly source: string;
  readonly author: string;
  readonly retrievedAt: string;
  /** `""` means "no checksum" — see module comment. */
  readonly checksum: string;
}

export interface FieldIssue {
  /** Dot-joined zod issue path, e.g. `"provenance.source"`, `"tags.0"`, or `"tags"`. */
  readonly field: string;
  readonly message: string;
}

export interface FrontmatterFormState {
  /** The last saved/loaded value. Only ever replaced wholesale by `init`, never patched in place. */
  readonly initial: OkfFrontmatter;
  readonly title: string;
  readonly trust: TrustLevel;
  readonly lifecycle: Lifecycle;
  readonly tags: readonly string[];
  readonly provenance: FrontmatterProvenanceDraft;
  readonly issues: readonly FieldIssue[];
}

type Draft = Omit<FrontmatterFormState, "initial" | "issues">;

function draftFromFrontmatter(frontmatter: OkfFrontmatter): Draft {
  return {
    title: frontmatter.title,
    trust: frontmatter.trust,
    lifecycle: frontmatter.lifecycle,
    tags: [...frontmatter.tags],
    provenance: {
      source: frontmatter.provenance.source,
      author: frontmatter.provenance.author,
      retrievedAt: frontmatter.provenance.retrievedAt,
      checksum: frontmatter.provenance.checksum ?? "",
    },
  };
}

function buildCandidate(state: FrontmatterFormState): unknown {
  const provenance: Record<string, unknown> = { ...state.initial.provenance };
  provenance["source"] = state.provenance.source;
  provenance["author"] = state.provenance.author;
  provenance["retrievedAt"] = state.provenance.retrievedAt;
  if (state.provenance.checksum) {
    provenance["checksum"] = state.provenance.checksum;
  } else {
    delete provenance["checksum"];
  }

  return {
    ...state.initial,
    title: state.title,
    trust: state.trust,
    lifecycle: state.lifecycle,
    tags: [...state.tags],
    provenance,
  };
}

/** Re-validates `state` against the OKF frontmatter schema. Ignores `state.issues` itself. */
export function validate(state: FrontmatterFormState): readonly FieldIssue[] {
  const result = okfFrontmatterSchema.safeParse(buildCandidate(state));
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "root",
    message: issue.message,
  }));
}

function commit(state: FrontmatterFormState, patch: Partial<Draft>): FrontmatterFormState {
  const next: FrontmatterFormState = { ...state, ...patch };
  return { ...next, issues: validate(next) };
}

/** Builds the initial form state from a loaded/saved {@link OkfFrontmatter}. */
export function init(frontmatter: OkfFrontmatter): FrontmatterFormState {
  const state: FrontmatterFormState = { initial: frontmatter, ...draftFromFrontmatter(frontmatter), issues: [] };
  return { ...state, issues: validate(state) };
}

/** Sets one of the free-text fields (title or a provenance field). */
export function setField(state: FrontmatterFormState, field: FrontmatterTextFieldKey, value: string): FrontmatterFormState {
  if (field === "title") {
    return commit(state, { title: value });
  }
  const provenanceKey = field.slice("provenance.".length) as keyof FrontmatterProvenanceDraft;
  return commit(state, { provenance: { ...state.provenance, [provenanceKey]: value } });
}

export function setTrust(state: FrontmatterFormState, trust: TrustLevel): FrontmatterFormState {
  return commit(state, { trust });
}

export function setLifecycle(state: FrontmatterFormState, lifecycle: Lifecycle): FrontmatterFormState {
  return commit(state, { lifecycle });
}

/** Adds `tag` (trimmed) unless it is empty or a case-insensitive duplicate of an existing tag. */
export function addTag(state: FrontmatterFormState, tag: string): FrontmatterFormState {
  const trimmed = tag.trim();
  if (!trimmed) {
    return state;
  }
  const lower = trimmed.toLowerCase();
  if (state.tags.some((existing) => existing.toLowerCase() === lower)) {
    return state;
  }
  return commit(state, { tags: [...state.tags, trimmed] });
}

export function removeTag(state: FrontmatterFormState, tag: string): FrontmatterFormState {
  return commit(state, { tags: state.tags.filter((existing) => existing !== tag) });
}

/** True when any editable field differs from `state.initial`. */
export function isDirty(state: FrontmatterFormState): boolean {
  const draft = draftFromFrontmatter(state.initial);
  return (
    draft.title !== state.title ||
    draft.trust !== state.trust ||
    draft.lifecycle !== state.lifecycle ||
    draft.provenance.source !== state.provenance.source ||
    draft.provenance.author !== state.provenance.author ||
    draft.provenance.retrievedAt !== state.provenance.retrievedAt ||
    draft.provenance.checksum !== state.provenance.checksum ||
    draft.tags.length !== state.tags.length ||
    draft.tags.some((tag, index) => tag !== state.tags[index])
  );
}

/** Returns the validated {@link OkfFrontmatter}, or `null` while `state.issues` is non-empty. */
export function toFrontmatter(state: FrontmatterFormState): OkfFrontmatter | null {
  if (state.issues.length > 0) {
    return null;
  }
  const result = okfFrontmatterSchema.safeParse(buildCandidate(state));
  return result.success ? result.data : null;
}
