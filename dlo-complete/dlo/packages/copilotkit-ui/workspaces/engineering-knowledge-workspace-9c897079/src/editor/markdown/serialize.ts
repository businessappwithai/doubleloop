// src/editor/markdown/serialize.ts — `editorStateToMarkdown`/`markdownToEditorState` wrap
// `@lexical/markdown`'s `$convertToMarkdownString`/`$convertFromMarkdownString` with this
// editor's `EDITOR_TRANSFORMERS` set (the custom code-block/divider transformers plus
// `@lexical/markdown`'s own), so every caller serialises through the same transformer list the
// custom nodes need to round-trip.
//
// `$populateFromMarkdown` is the underlying `$`-prefixed operation, callable directly inside any
// already-active editor update — in particular, `BlockEditor.tsx` passes it (partially applied)
// as `InitialConfigType.editorState`, which `LexicalComposer` invokes from *inside* its own
// initial `editor.update()`. Calling `markdownToEditorState`'s wrapping `editor.update()` there
// instead would nest one update inside another for no reason; `$populateFromMarkdown` gives
// external callers (a "load document" action, tests) the `editor.update()`-wrapped convenience
// version while letting internal callers already holding update context skip the wrapper.
//
// It also guarantees the root never ends up with zero children: `$convertFromMarkdownString` on
// an empty or whitespace-only string clears the root and imports nothing, and a Lexical root
// with no children cannot host a text cursor. Appending a single empty paragraph in that case
// keeps the editor usable without changing what a non-empty document round-trips to.
import { $createParagraphNode, $getRoot, type LexicalEditor } from "lexical";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { EDITOR_TRANSFORMERS } from "./transformers";

/** Serialises `editor`'s current state to markdown using {@link EDITOR_TRANSFORMERS}. */
export function editorStateToMarkdown(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $convertToMarkdownString([...EDITOR_TRANSFORMERS]));
}

/**
 * Replaces the current editor's root content with the parsed contents of `markdown`. Must be
 * called from inside an active editor update (an `editor.update()` callback, or as an
 * `InitialConfigType.editorState` initialiser, which Lexical already runs inside one). See the
 * module header for why this is split out from {@link markdownToEditorState}.
 */
export function $populateFromMarkdown(markdown: string): void {
  $convertFromMarkdownString(markdown, [...EDITOR_TRANSFORMERS]);
  const root = $getRoot();
  if (root.getChildrenSize() === 0) {
    root.append($createParagraphNode());
  }
}

/**
 * Replaces `editor`'s root content with the parsed contents of `markdown`. Runs as a discrete
 * (synchronous) update so callers can read the resulting state immediately afterward, without
 * waiting for the next microtask flush. For use from outside an already-active update — see
 * {@link $populateFromMarkdown} for use from inside one.
 */
export function markdownToEditorState(editor: LexicalEditor, markdown: string): void {
  editor.update(() => $populateFromMarkdown(markdown), { discrete: true });
}
