import { test, expect } from "vitest";
import { createEditor, $getRoot, $createParagraphNode, $createTextNode, $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND } from "lexical";
import { registerRichText } from "@lexical/rich-text";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

test("headless format toggle sequence", async () => {
  const editor = createEditor({
    namespace: "headless",
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
    onError: (e) => { throw e; },
  });
  const div = document.createElement("div");
  editor.setRootElement(div);
  registerRichText(editor);

  editor.update(() => {
    const root = $getRoot().clear();
    const paragraph = $createParagraphNode();
    const text = $createTextNode("hello world");
    paragraph.append(text);
    root.append(paragraph);
    text.select(0, text.getTextContentSize());
  }, { discrete: true });

  for (const fmt of ["italic", "underline", "strikethrough", "code"] as const) {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, fmt);
    await flush();
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      const hasIt = $isRangeSelection(sel) ? sel.hasFormat(fmt) : "n/a";
      const node = $getRoot().getFirstChild()?.getFirstChild() as any;
      console.log("after", fmt, "hasFormat=", hasIt, "nodeFormat=", node?.getFormat?.(), "selAnchorKey", $isRangeSelection(sel) ? sel.anchor.key : null, "nodeKey", node?.getKey?.());
    });
  }
});
