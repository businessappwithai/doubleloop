// tests/frontmatter-panel.test.tsx — module m20 (OKF frontmatter editing panel). Covers
// FrontmatterPanel.tsx: initial render from a saved frontmatter, editing every text field,
// selecting each TrustLevel/Lifecycle option, adding/removing tags (including duplicate
// rejection), the dirty indicator and Revert/Save button enablement, Save invoking onSave only
// with a valid value, an inline error linked by aria-describedby when a required field is
// cleared, and the form resetting when the concept identity (frontmatter.id) changes.
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FrontmatterPanel } from "../src/features/frontmatter/FrontmatterPanel";
import type { OkfFrontmatter } from "../src/core/okf/schema";

const COMPLETE: OkfFrontmatter = {
  id: "concept-1",
  title: "Deployment Runbook",
  trust: "human-reviewed",
  lifecycle: "active",
  provenance: {
    source: "https://example.com/doc",
    author: "jane@example.com",
    retrievedAt: "2026-01-15T10:00:00.000Z",
    checksum: "sha256:abc123",
  },
  tags: ["ops", "runbook"],
  links: ["concept-2"],
  updatedAt: "2026-01-15T10:00:00.000Z",
};

const MINIMAL: OkfFrontmatter = {
  id: "concept-2",
  title: "Untitled Concept",
  trust: "unverified",
  lifecycle: "draft",
  provenance: {
    source: "manual",
    author: "unknown",
    retrievedAt: "2026-01-15T10:00:00.000Z",
  },
  tags: [],
  links: [],
  updatedAt: "2026-01-15T10:00:00.000Z",
};

function idFor(element: Element): string[] {
  return (element.getAttribute("aria-describedby") ?? "").trim().split(/\s+/).filter(Boolean);
}

describe("FrontmatterPanel", () => {
  test("renders every saved field: title, provenance, trust, lifecycle, and tags", () => {
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Deployment Runbook");
    expect(screen.getByRole("textbox", { name: "Source" })).toHaveValue("https://example.com/doc");
    expect(screen.getByRole("textbox", { name: "Author" })).toHaveValue("jane@example.com");
    expect(screen.getByRole("textbox", { name: "Retrieved at" })).toHaveValue("2026-01-15T10:00:00.000Z");
    expect(screen.getByRole("textbox", { name: "Checksum" })).toHaveValue("sha256:abc123");

    expect(screen.getByRole("radio", { name: "Human-reviewed" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Active" })).toBeChecked();

    expect(screen.getByText("ops")).toBeInTheDocument();
    expect(screen.getByText("runbook")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  test("renders an empty tag state and defaulted checksum for a minimal frontmatter", () => {
    render(<FrontmatterPanel frontmatter={MINIMAL} onSave={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Untitled Concept");
    expect(screen.getByRole("textbox", { name: "Checksum" })).toHaveValue("");
    expect(screen.getByText("No tags yet.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Unverified" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Draft" })).toBeChecked();
  });

  test("Save and Revert start disabled, since the form is not yet dirty", () => {
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled();
  });

  test("editing the title marks the form dirty and enables Save/Revert", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    const titleInput = screen.getByRole("textbox", { name: "Title" });
    await user.type(titleInput, " v2");

    expect(titleInput).toHaveValue("Deployment Runbook v2");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled();
  });

  test("editing each provenance field updates its value independently", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    const author = screen.getByRole("textbox", { name: "Author" });
    await user.clear(author);
    await user.type(author, "new-author@example.com");

    expect(author).toHaveValue("new-author@example.com");
    expect(screen.getByRole("textbox", { name: "Source" })).toHaveValue("https://example.com/doc");
    expect(screen.getByRole("textbox", { name: "Retrieved at" })).toHaveValue("2026-01-15T10:00:00.000Z");
    expect(screen.getByRole("textbox", { name: "Checksum" })).toHaveValue("sha256:abc123");
  });

  test("selects each TrustLevel option via its radio", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={MINIMAL} onSave={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "Machine-confirmed" }));
    expect(screen.getByRole("radio", { name: "Machine-confirmed" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Human-reviewed" }));
    expect(screen.getByRole("radio", { name: "Human-reviewed" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Machine-confirmed" })).not.toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Unverified" }));
    expect(screen.getByRole("radio", { name: "Unverified" })).toBeChecked();
  });

  test("selects each Lifecycle option via its radio", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={MINIMAL} onSave={vi.fn()} />);

    for (const label of ["Active", "Deprecated", "Archived", "Draft"]) {
      await user.click(screen.getByRole("radio", { name: label }));
      expect(screen.getByRole("radio", { name: label })).toBeChecked();
    }
  });

  test("adds a tag via the Add tag button", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={MINIMAL} onSave={vi.fn()} />);

    const tagInput = screen.getByPlaceholderText("Add a tag");
    await user.type(tagInput, "platform");
    await user.click(screen.getByRole("button", { name: "Add tag" }));

    expect(screen.getByText("platform")).toBeInTheDocument();
    expect(tagInput).toHaveValue("");
  });

  test("adds a tag by pressing Enter in the tag input", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={MINIMAL} onSave={vi.fn()} />);

    const tagInput = screen.getByPlaceholderText("Add a tag");
    await user.type(tagInput, "ops{Enter}");

    expect(screen.getByText("ops")).toBeInTheDocument();
    expect(tagInput).toHaveValue("");
  });

  test("rejects a case-insensitive duplicate tag, leaving the tag list unchanged", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    const tagInput = screen.getByPlaceholderText("Add a tag");
    await user.type(tagInput, "OPS{Enter}");

    expect(screen.getAllByText(/^ops$/i)).toHaveLength(1);
  });

  test("the Add tag button is disabled while the tag draft is empty or whitespace", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={MINIMAL} onSave={vi.fn()} />);

    const addButton = screen.getByRole("button", { name: "Add tag" });
    expect(addButton).toBeDisabled();

    const tagInput = screen.getByPlaceholderText("Add a tag");
    await user.type(tagInput, "   ");
    expect(addButton).toBeDisabled();

    await user.type(tagInput, "x");
    expect(addButton).toBeEnabled();
  });

  test("removes a tag via its token's remove control", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    expect(screen.getByText("ops")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /remove.*ops/i }));

    expect(screen.queryByText("ops")).not.toBeInTheDocument();
    expect(screen.getByText("runbook")).toBeInTheDocument();
  });

  test("removing the last tag shows the empty-tags message again", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={MINIMAL} onSave={vi.fn()} />);

    const tagInput = screen.getByPlaceholderText("Add a tag");
    await user.type(tagInput, "solo{Enter}");
    expect(screen.getByText("solo")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /remove.*solo/i }));
    expect(screen.getByText("No tags yet.")).toBeInTheDocument();
  });

  test("Revert restores every edited field, radio selection, and tag to the saved value", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    const titleInput = screen.getByRole("textbox", { name: "Title" });
    await user.type(titleInput, " EDITED");
    await user.click(screen.getByRole("radio", { name: "Unverified" }));
    const tagInput = screen.getByPlaceholderText("Add a tag");
    await user.type(tagInput, "extra{Enter}");

    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Revert" }));

    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Deployment Runbook");
    expect(screen.getByRole("radio", { name: "Human-reviewed" })).toBeChecked();
    expect(screen.queryByText("extra")).not.toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled();
  });

  test("Save is disabled while a required field is invalid, even though the form is dirty", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    const titleInput = screen.getByRole("textbox", { name: "Title" });
    await user.clear(titleInput);

    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  test("shows an inline error linked by aria-describedby when the title is cleared", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    const titleInput = screen.getByRole("textbox", { name: "Title" });
    await user.clear(titleInput);

    const errorMessage = screen.getByText("title must not be empty");
    const describedByIds = idFor(titleInput);
    expect(describedByIds.length).toBeGreaterThan(0);
    expect(describedByIds).toContain(errorMessage.id);
  });

  test("clears the inline error once the field is valid again", async () => {
    const user = userEvent.setup();
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    const titleInput = screen.getByRole("textbox", { name: "Title" });
    await user.clear(titleInput);
    expect(screen.getByText("title must not be empty")).toBeInTheDocument();

    await user.type(titleInput, "New Title");
    expect(screen.queryByText("title must not be empty")).not.toBeInTheDocument();
  });

  test("Save calls onSave with the validated frontmatter and clears the dirty state", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={onSave} />);

    const titleInput = screen.getByRole("textbox", { name: "Title" });
    await user.type(titleInput, " v2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      ...COMPLETE,
      title: "Deployment Runbook v2",
    });
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  test("Save does nothing while the form is invalid", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<FrontmatterPanel frontmatter={COMPLETE} onSave={onSave} />);

    const titleInput = screen.getByRole("textbox", { name: "Title" });
    await user.clear(titleInput);
    // The Save button is disabled via isDisabled, which also blocks the click handler
    // itself from firing onSave — assert the guard, not just the disabled attribute.
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
  });

  test("resets the form when frontmatter.id changes, discarding in-progress edits", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    const titleInput = screen.getByRole("textbox", { name: "Title" });
    await user.type(titleInput, " EDITED");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    rerender(<FrontmatterPanel frontmatter={MINIMAL} onSave={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Untitled Concept");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  test("does not reset in-progress edits when re-rendered with an equal frontmatter of the same id", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FrontmatterPanel frontmatter={COMPLETE} onSave={vi.fn()} />);

    const titleInput = screen.getByRole("textbox", { name: "Title" });
    await user.type(titleInput, " EDITED");

    rerender(<FrontmatterPanel frontmatter={{ ...COMPLETE }} onSave={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Deployment Runbook EDITED");
  });
});
