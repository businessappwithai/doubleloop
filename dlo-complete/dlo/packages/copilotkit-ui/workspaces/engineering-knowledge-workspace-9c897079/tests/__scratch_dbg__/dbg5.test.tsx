import { test } from "vitest";
import { render, act } from "@testing-library/react";
import { $getRoot, $isTextNode, $createParagraphNode, $createTextNode, FORMAT_TEXT_COMMAND } from "lexical";
import { BlockEditor } from "../../src/editor/BlockEditor";

HTMLCanvasElement.prototype.getContext = (() => null) as any;
Range.prototype.getBoundingClientRect = (() => ({x:0,y:0,width:0,height:0,top:0,right:0,bottom:0,left:0,toJSON:()=>({})})) as any;
Range.prototype.getClientRects = (() => []) as any;

test("dispatch bold, italic, underline directly - is it ordinal position or format-specific", async () => {
  let editor: any;
  render(<BlockEditor namespace="dbg5" onEditorReady={(e) => { editor = e; }} />);
  await act(async () => { await Promise.resolve(); });

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
      console.log(label, "format bits:", $isTextNode(node) ? node.getFormat() : "n/a");
    });
  };

  for (const fmt of ["bold", "italic", "underline"] as const) {
    act(() => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, fmt);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    log(`after ${fmt}`);
  }
});
