// src/features/frontmatter/index.ts — barrel for the OKF frontmatter editor feature (m20).
// Later modules (the concept page, m21) import the panel and its pure form-state helpers from
// here rather than reaching into individual files.
export { FrontmatterPanel, type FrontmatterPanelProps } from "./FrontmatterPanel";
export {
  addTag,
  init,
  isDirty,
  removeTag,
  setField,
  setLifecycle,
  setTrust,
  toFrontmatter,
  validate,
  type FieldIssue,
  type FrontmatterFormState,
  type FrontmatterProvenanceDraft,
  type FrontmatterTextFieldKey,
} from "./form-state";
export {
  findFieldIssue,
  LIFECYCLE_OPTIONS,
  TEXT_FIELDS,
  TRUST_OPTIONS,
  type FrontmatterFieldOption,
  type FrontmatterTextFieldDescriptor,
} from "./fields";
