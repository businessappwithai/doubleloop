import { test } from "vitest";
import { render, act } from "@testing-library/react";
import { $getRoot, $isTextNode, $createParagraphNode, $createTextNode, FORMAT_TEXT_COMMAND, $getSelection, $isRangeSelection } from "lexical";
import { BlockEditor } from "../../src/editor/BlockEditor";

HTMLCanvasElement.prototype.getContext = (() => null) as any;
Range.prototype.getBoundingClientRect = (() => ({x:0,y:0,width:0,height:0,top:0,right:0,bottom:0,left:0,toJSON:()=>({})})) as any;
Range.prototype.getClientRects = (() => []) as any;

test("instrumented dispatch", async () => {
  let editor: any;
  render(<BlockEditor namespace="dbg6" onEditorReady={(e) => { editor = e; }} />);
  await act(async () => { await Promise.resolve(); });

  let updateCount = 0;
  editor.registerUpdateListener(({ tags }: any) => {
    updateCount++;
    console.log("update #", updateCount, "tags=", [...tags]);
  });

  act(() => {
    editor.update(() => {
      const root = $getRoot().clear();
      const paragraph = $createParagraphNode();
      const text = $createTextNode("hello world");
      paragraph.append(text);
      root.append(paragraph);
      text.select(0, text.getTextContentSize());
    }, { discrete: true });
  });

  const log = (label: string) => {
    editor.getEditorState().read(() => {
      const node = $getRoot().getFirstChild()?.getFirstChild();
      const sel = $getSelection();
      console.log(label, "format bits:", $isTextNode(node) ? node.getFormat() : "n/a",
        "selType", sel?.constructor?.name,
        "isRange", $isRangeSelection(sel),
        "anchorOffset", $isRangeSelection(sel) ? sel.anchor.offset : null,
        "focusOffset", $isRangeSelection(sel) ? sel.focus.offset : null,
      );
    });
  };

  for (const fmt of ["italic", "underline", "strikethrough"] as const) {
    let handled: any;
    act(() => {
      handled = editor.dispatchCommand(FORMAT_TEXT_COMMAND, fmt);
    });
    console.log(`dispatch(${fmt}) returned`, handled);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    log(`after ${fmt}`);
  }
});
