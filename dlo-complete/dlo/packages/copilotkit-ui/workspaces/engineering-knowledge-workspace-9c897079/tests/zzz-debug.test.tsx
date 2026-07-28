import { describe, test, expect } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { $getRoot, $isTextNode, $createParagraphNode, $createTextNode } from "lexical";
import { BlockEditor } from "../src/editor/BlockEditor";

HTMLCanvasElement.prototype.getContext = (() => null) as any;
Range.prototype.getBoundingClientRect = (() => ({x:0,y:0,width:0,height:0,top:0,right:0,bottom:0,left:0,toJSON:()=>({})})) as any;
Range.prototype.getClientRects = (() => []) as any;

test("debug format toggling", async () => {
  let editor: any;
  render(<BlockEditor namespace="dbg" onEditorReady={(e) => { editor = e; }} />);
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

  const log = () => {
    editor.getEditorState().read(() => {
      const node = $getRoot().getFirstChild()?.getFirstChild();
      console.log("format bits:", $isTextNode(node) ? node.getFormat() : "n/a", "children count:", $getRoot().getFirstChild()?.getChildrenSize());
    });
  };
  log();

  for (const name of ["Italic", "Underline", "Strikethrough", "Inline code"]) {
    const button = screen.getByRole("button", { name });
    fireEvent.click(button);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    log();
    console.log(name, "pressed=", button.getAttribute("aria-pressed"));
  }
});
