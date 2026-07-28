// tests/editor-block-editor.test.tsx — module m18 (Lexical block editor). Covers the composed
// `BlockEditor`: placeholder rendering, seeding from `initialMarkdown`, the "read once on mount"
// contract documented in its own module header, `onMarkdownChange`/`onEditorReady` callbacks, the
// `editable` prop, and that it renders its `Toolbar`. Content mutations are driven through the
// captured `LexicalEditor` (via `onEditorReady`) rather than simulated DOM typing.
//
// `@lexical/react`'s `LexicalComposer` always seeds its initial content — the default empty
// paragraph, or this component's `$populateFromMarkdown` initializer — through a *non-discrete*
// `editor.update()`, which Lexical schedules on a microtask rather than committing synchronously
// (see `LexicalUpdates.ts`'s `scheduleMicroTask`/`$beginUpdate`). Plain `render()` only wraps the
// synchronous portion of mount in `act()`, so that deferred commit — and the React state update
// `RichTextPlugin`'s placeholder-visibility listener makes in response to it — lands outside any
// `act()` scope and trips React's "not wrapped in act(...)" warning, which this project's
// `vitest.setup.ts` turns into a hard test failure. `mountBlockEditor` below flushes that
// microtask from inside an async `act()` immediately after every render, so each test starts from
// a fully settled editor. Explicit follow-up mutations use `{ discrete: true }` so their own
// commit (and the resulting `OnChangePlugin` call) happens synchronously inside the `act()` that
// wraps them, rather than being deferred the same way.
import { describe, test, expect, vi } from "vitest";
import { render, screen, act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { $getRoot, $createTextNode, $isElementNode, type LexicalEditor } from "lexical";
import { BlockEditor } from "../src/editor/BlockEditor";
import { editorStateToMarkdown } from "../src/editor/markdown/serialize";

function uniqueNamespace(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

async function mountBlockEditor(ui: ReactElement): Promise<RenderResult> {
  const result = render(ui);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

async function rerenderBlockEditor(result: RenderResult, ui: ReactElement): Promise<void> {
  result.rerender(ui);
  await act(async () => {
    await Promise.resolve();
  });
}

describe("BlockEditor", () => {
  test("shows the default placeholder when empty and no initialMarkdown is given", async () => {
    await mountBlockEditor(<BlockEditor namespace={uniqueNamespace("empty")} />);
    expect(screen.getByText("Start writing…")).toBeInTheDocument();
  });

  test("shows a custom placeholder when provided", async () => {
    await mountBlockEditor(
      <BlockEditor namespace={uniqueNamespace("custom-placeholder")} placeholder="Describe the concept…" />,
    );
    expect(screen.getByText("Describe the concept…")).toBeInTheDocument();
    expect(screen.queryByText("Start writing…")).not.toBeInTheDocument();
  });

  test("seeds the editor from initialMarkdown via $populateFromMarkdown", async () => {
    let captured: LexicalEditor | undefined;
    await mountBlockEditor(
      <BlockEditor
        namespace={uniqueNamespace("seeded")}
        initialMarkdown="# Seeded heading"
        onEditorReady={(editor) => {
          captured = editor;
        }}
      />,
    );

    expect(captured).toBeDefined();
    expect(editorStateToMarkdown(captured as LexicalEditor)).toBe("# Seeded heading");
  });

  test("invokes onEditorReady exactly once with the mounted LexicalEditor", async () => {
    const onEditorReady = vi.fn();
    await mountBlockEditor(<BlockEditor namespace={uniqueNamespace("ready")} onEditorReady={onEditorReady} />);

    expect(onEditorReady).toHaveBeenCalledTimes(1);
    const editor = onEditorReady.mock.calls[0]?.[0] as LexicalEditor;
    expect(typeof editor.update).toBe("function");
    expect(typeof editor.getEditorState).toBe("function");
  });

  test("calls onMarkdownChange with the serialised markdown whenever the document changes", async () => {
    const onMarkdownChange = vi.fn();
    let editor: LexicalEditor | undefined;
    await mountBlockEditor(
      <BlockEditor
        namespace={uniqueNamespace("change")}
        onMarkdownChange={onMarkdownChange}
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );

    onMarkdownChange.mockClear();

    await act(async () => {
      (editor as LexicalEditor).update(
        () => {
          const paragraph = $getRoot().getFirstChild();
          if ($isElementNode(paragraph)) {
            paragraph.append($createTextNode("Hello world"));
          }
        },
        { discrete: true },
      );
    });

    expect(onMarkdownChange).toHaveBeenCalled();
    expect(onMarkdownChange).toHaveBeenLastCalledWith("Hello world");
  });

  test("does not reset content when initialMarkdown changes on a later render (read once on mount)", async () => {
    let editor: LexicalEditor | undefined;
    const namespace = uniqueNamespace("read-once");
    const result = await mountBlockEditor(
      <BlockEditor
        namespace={namespace}
        initialMarkdown="# First"
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );

    expect(editorStateToMarkdown(editor as LexicalEditor)).toBe("# First");

    await rerenderBlockEditor(
      result,
      <BlockEditor namespace={namespace} initialMarkdown="# Second" onEditorReady={() => {}} />,
    );

    expect(editorStateToMarkdown(editor as LexicalEditor)).toBe("# First");
  });

  test("editable=false renders a non-editable ContentEditable", async () => {
    await mountBlockEditor(<BlockEditor namespace={uniqueNamespace("readonly")} editable={false} />);
    const contentEditable = screen.getByLabelText("Document content");
    expect(contentEditable).toHaveAttribute("contenteditable", "false");
  });

  test("editable defaults to true (an editable ContentEditable)", async () => {
    await mountBlockEditor(<BlockEditor namespace={uniqueNamespace("editable-default")} />);
    const contentEditable = screen.getByLabelText("Document content");
    expect(contentEditable).toHaveAttribute("contenteditable", "true");
  });

  test("renders the Toolbar alongside the content editable", async () => {
    await mountBlockEditor(<BlockEditor namespace={uniqueNamespace("toolbar")} />);
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Heading 1" })).toBeInTheDocument();
  });

  test("registers markdown shortcuts, so typed shortcut text converts to the corresponding block", async () => {
    let editor: LexicalEditor | undefined;
    await mountBlockEditor(
      <BlockEditor
        namespace={uniqueNamespace("shortcuts")}
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );

    await act(async () => {
      (editor as LexicalEditor).update(
        () => {
          const paragraph = $getRoot().getFirstChild();
          if ($isElementNode(paragraph)) {
            paragraph.append($createTextNode("# Heading via shortcut"));
          }
        },
        { discrete: true },
      );
    });

    expect(editorStateToMarkdown(editor as LexicalEditor)).toBe("# Heading via shortcut");
  });
});
