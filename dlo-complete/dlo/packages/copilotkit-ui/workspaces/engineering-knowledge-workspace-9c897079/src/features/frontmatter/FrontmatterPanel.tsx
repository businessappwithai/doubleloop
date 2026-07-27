// src/features/frontmatter/FrontmatterPanel.tsx — the OKF frontmatter editor panel
// (Implementation.md m20). Composes Astryx primitives over the pure `form-state.ts` reducer:
// every keystroke/click dispatches a reducer action and re-renders from the returned state, so
// this component owns no validation logic of its own — `state.issues` (recomputed by the reducer
// on every action) is the single source of per-field error messages. Trust/lifecycle use
// `RadioList` rather than a popover `Selector`: both are small closed option sets, and a native
// radio group is synchronous and portal-free, which matters under vitest.setup.ts's
// console.error-is-a-test-failure policy (a popover's async open/close/focus handling is a much
// larger surface for a stray act() warning). `TextInput`/`RadioList`/`Field` already wire a
// `status.message` to the control via `aria-describedby` internally (see their compiled output),
// so this panel never builds an aria-describedby id itself. The form resets to `init(frontmatter)`
// whenever the concept identity (`frontmatter.id`) changes, so navigating to a different concept
// does not leak the previous concept's in-progress edits.
import { useEffect, useId, useState, type ReactElement } from "react";
import * as stylex from "@stylexjs/stylex";
import { Badge, Button, Field, RadioList, RadioListItem, Stack, Text, TextInput, Token } from "@astryxdesign/core";
import type { Lifecycle, TrustLevel } from "../../core/types";
import type { OkfFrontmatter } from "../../core/okf/schema";
import {
  addTag,
  init,
  isDirty,
  removeTag,
  setField,
  setLifecycle,
  setTrust,
  toFrontmatter,
  type FrontmatterFormState,
  type FrontmatterTextFieldKey,
} from "./form-state";
import { findFieldIssue, LIFECYCLE_OPTIONS, TEXT_FIELDS, TRUST_OPTIONS } from "./fields";

const styles = stylex.create({
  panel: {
    width: "100%",
  },
  tagList: {
    width: "100%",
  },
  tagAdd: {
    width: "100%",
  },
  tagInput: {
    flexGrow: 1,
  },
});

export interface FrontmatterPanelProps {
  /** The concept's saved frontmatter. The form resets whenever `frontmatter.id` changes. */
  readonly frontmatter: OkfFrontmatter;
  /** Called with the validated {@link OkfFrontmatter} when the user saves. */
  readonly onSave: (frontmatter: OkfFrontmatter) => void;
}

function fieldValue(state: FrontmatterFormState, key: FrontmatterTextFieldKey): string {
  if (key === "title") {
    return state.title;
  }
  const provenanceKey = key.slice("provenance.".length) as "source" | "author" | "retrievedAt" | "checksum";
  return state.provenance[provenanceKey];
}

function fieldStatus(state: FrontmatterFormState, key: string): { readonly status?: { type: "error"; message: string } } {
  const issue = findFieldIssue(state.issues, key);
  return issue ? { status: { type: "error", message: issue.message } } : {};
}

/** The OKF frontmatter editor: title/provenance fields, trust/lifecycle, tags, save/revert. */
export function FrontmatterPanel({ frontmatter, onSave }: FrontmatterPanelProps): ReactElement {
  const [state, setState] = useState<FrontmatterFormState>(() => init(frontmatter));
  const [tagDraft, setTagDraft] = useState("");
  const provenanceLabelId = useId();
  const provenanceInputId = useId();
  const tagsLabelId = useId();
  const tagsInputId = useId();

  useEffect(() => {
    setState(init(frontmatter));
    setTagDraft("");
    // Reset only when the concept identity changes, not on every parent re-render with an
    // otherwise-equal frontmatter object (which would silently discard in-progress edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontmatter.id]);

  const dirty = isDirty(state);
  const titleField = TEXT_FIELDS.find((field) => field.key === "title");
  if (!titleField) {
    throw new Error("FrontmatterPanel: TEXT_FIELDS is missing the 'title' descriptor");
  }
  const provenanceFields = TEXT_FIELDS.filter((field) => field.key !== "title");

  function handleTextChange(key: FrontmatterTextFieldKey, value: string): void {
    setState((prev) => setField(prev, key, value));
  }

  function handleAddTag(): void {
    if (!tagDraft.trim()) {
      return;
    }
    setState((prev) => addTag(prev, tagDraft));
    setTagDraft("");
  }

  function handleRevert(): void {
    setState(init(state.initial));
    setTagDraft("");
  }

  function handleSave(): void {
    const next = toFrontmatter(state);
    if (!next) {
      return;
    }
    onSave(next);
    setState(init(next));
  }

  return (
    <Stack direction="vertical" gap={4} padding={4} xstyle={styles.panel} role="region" aria-label="Frontmatter">
      <Stack direction="horizontal" hAlign="between" vAlign="center" gap={2}>
        <Text type="label" weight="semibold" as="h2">
          Frontmatter
        </Text>
        {dirty ? <Badge variant="warning" label="Unsaved changes" /> : null}
      </Stack>

      <TextInput
        label={titleField.label}
        description={titleField.helpText}
        value={state.title}
        onChange={(value) => handleTextChange("title", value)}
        {...fieldStatus(state, "title")}
      />

      <RadioList
        label="Trust"
        value={state.trust}
        onChange={(value) => setState((prev) => setTrust(prev, value as TrustLevel))}
        {...fieldStatus(state, "trust")}
      >
        {TRUST_OPTIONS.map((option) => (
          <RadioListItem key={option.value} label={option.label} value={option.value} />
        ))}
      </RadioList>

      <RadioList
        label="Lifecycle"
        value={state.lifecycle}
        onChange={(value) => setState((prev) => setLifecycle(prev, value as Lifecycle))}
        {...fieldStatus(state, "lifecycle")}
      >
        {LIFECYCLE_OPTIONS.map((option) => (
          <RadioListItem key={option.value} label={option.label} value={option.value} />
        ))}
      </RadioList>

      <Field label="Provenance" isGroupLabel inputID={provenanceInputId} labelID={provenanceLabelId}>
        <Stack
          direction="vertical"
          gap={2}
          role="group"
          aria-labelledby={provenanceLabelId}
        >
          {provenanceFields.map((field) => (
            <TextInput
              key={field.key}
              label={field.label}
              description={field.helpText}
              isOptional={field.isOptional}
              value={fieldValue(state, field.key)}
              onChange={(value) => handleTextChange(field.key, value)}
              {...fieldStatus(state, field.key)}
            />
          ))}
        </Stack>
      </Field>

      <Field label="Tags" isGroupLabel inputID={tagsInputId} labelID={tagsLabelId} {...fieldStatus(state, "tags")}>
        <Stack direction="vertical" gap={2} role="group" aria-labelledby={tagsLabelId} xstyle={styles.tagList}>
          <Stack direction="horizontal" gap={1} wrap="wrap">
            {state.tags.length > 0 ? (
              state.tags.map((tag) => (
                <Token key={tag} label={tag} onRemove={() => setState((prev) => removeTag(prev, tag))} />
              ))
            ) : (
              <Text type="body" size="sm" color="secondary">
                No tags yet.
              </Text>
            )}
          </Stack>
          <Stack direction="horizontal" gap={2} vAlign="end" xstyle={styles.tagAdd}>
            <Stack xstyle={styles.tagInput}>
              <TextInput
                label="Add tag"
                isLabelHidden
                value={tagDraft}
                onChange={setTagDraft}
                onEnter={handleAddTag}
                placeholder="Add a tag"
              />
            </Stack>
            <Button label="Add tag" variant="secondary" onClick={handleAddTag} isDisabled={!tagDraft.trim()} />
          </Stack>
        </Stack>
      </Field>

      <Stack direction="horizontal" gap={2}>
        <Button label="Revert" variant="secondary" onClick={handleRevert} isDisabled={!dirty} />
        <Button label="Save" variant="primary" onClick={handleSave} isDisabled={!dirty || state.issues.length > 0} />
      </Stack>
    </Stack>
  );
}
