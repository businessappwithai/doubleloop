// tests/editor-nodes.test.tsx — module m18 (Lexical block editor). Covers `CodeBlockNode` and
// `DividerNode` directly: construction, clone, JSON export/import round trip, DOM export, and
// the type guards — independent of any React mounting. Each test builds its own headless
// `LexicalEditor` via `createEditor` (Lexical's own node-construction/read APIs require an
// active editor update/read context; a plain `new CodeBlockNode()` outside one throws), so no
// editor instance is shared between tests.
import { describe, test, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { createEditor, type EditorConfig, type LexicalEditor } from "lexical";
import {
  CodeBlockNode,
  $createCodeBlockNode,
  $isCodeBlockNode,
} from "../src/editor/nodes/code-block-node";
import { DividerNode, $createDividerNode, $isDividerNode } from "../src/editor/nodes/divider-node";
import { editorNodes, editorOnError, editorTheme } from "../src/editor/config/editor-config";

function createTestEditor(namespace: string): LexicalEditor {
  return createEditor({
    namespace,
    nodes: editorNodes,
    onError: editorOnError,
    theme: editorTheme,
  });
}

const FAKE_EDITOR_CONFIG: EditorConfig = { namespace: "test", theme: editorTheme };

let editor: LexicalEditor;

beforeEach(() => {
  editor = createTestEditor(`nodes-${Math.random().toString(36).slice(2)}`);
});

describe("CodeBlockNode", () => {
  test("constructor defaults language to 'plaintext' when not given", () => {
    let language = "";
    editor.update(
      () => {
        const node = new CodeBlockNode();
        language = node.getLanguage();
      },
      { discrete: true },
    );
    expect(language).toBe("plaintext");
  });

  test("constructor initializes both code and language directly, never leaving language unset", () => {
    let code = "";
    let language = "";
    editor.update(
      () => {
        const node = new CodeBlockNode("const x = 1;", "typescript");
        code = node.getCode();
        language = node.getLanguage();
      },
      { discrete: true },
    );
    expect(code).toBe("const x = 1;");
    expect(language).toBe("typescript");
  });

  test("$createCodeBlockNode defaults code to '' and language to 'plaintext'", () => {
    let code = "unset";
    let language = "unset";
    editor.update(
      () => {
        const node = $createCodeBlockNode();
        code = node.getCode();
        language = node.getLanguage();
      },
      { discrete: true },
    );
    expect(code).toBe("");
    expect(language).toBe("plaintext");
  });

  test("getType returns 'code-block'", () => {
    expect(CodeBlockNode.getType()).toBe("code-block");
  });

  test("clone preserves code, language, and key across a new instance", () => {
    let cloneCode = "";
    let cloneLanguage = "";
    let sameKey = false;
    let differentInstance = false;
    editor.update(
      () => {
        const original = $createCodeBlockNode("print(1)", "python");
        const cloned = CodeBlockNode.clone(original);
        cloneCode = cloned.getCode();
        cloneLanguage = cloned.getLanguage();
        sameKey = cloned.__key === original.__key;
        differentInstance = cloned !== original;
      },
      { discrete: true },
    );
    expect(cloneCode).toBe("print(1)");
    expect(cloneLanguage).toBe("python");
    expect(sameKey).toBe(true);
    expect(differentInstance).toBe(true);
  });

  test("exportJSON / importJSON round trip preserves code and language", () => {
    let roundTripCode = "";
    let roundTripLanguage = "";
    let roundTripType = "";
    let roundTripVersion = -1;
    editor.update(
      () => {
        const original = $createCodeBlockNode("SELECT 1;", "sql");
        const json = original.exportJSON();
        roundTripType = json.type;
        roundTripVersion = json.version;
        const imported = CodeBlockNode.importJSON(json);
        roundTripCode = imported.getCode();
        roundTripLanguage = imported.getLanguage();
      },
      { discrete: true },
    );
    expect(roundTripType).toBe("code-block");
    expect(roundTripVersion).toBe(1);
    expect(roundTripCode).toBe("SELECT 1;");
    expect(roundTripLanguage).toBe("sql");
  });

  test("createDOM returns a div element regardless of config", () => {
    let tagName = "";
    editor.update(
      () => {
        const node = $createCodeBlockNode();
        tagName = node.createDOM(FAKE_EDITOR_CONFIG).tagName;
      },
      { discrete: true },
    );
    expect(tagName).toBe("DIV");
  });

  test("updateDOM always returns false (no DOM update path)", () => {
    let result: unknown;
    editor.update(
      () => {
        const node = $createCodeBlockNode();
        result = node.updateDOM();
      },
      { discrete: true },
    );
    expect(result).toBe(false);
  });

  test("isInline returns false", () => {
    let result: unknown;
    editor.update(
      () => {
        result = $createCodeBlockNode().isInline();
      },
      { discrete: true },
    );
    expect(result).toBe(false);
  });

  test("exportDOM produces a <pre><code data-language=...> element carrying the code text", () => {
    let outerHTML = "";
    let tagName = "";
    let codeTagName = "";
    let codeText = "";
    let languageAttr: string | null = null;
    editor.update(
      () => {
        const node = $createCodeBlockNode("const x = 1;", "typescript");
        const { element } = node.exportDOM(editor);
        const pre = element as HTMLElement;
        tagName = pre.tagName;
        const code = pre.firstElementChild as HTMLElement;
        codeTagName = code.tagName;
        codeText = code.textContent ?? "";
        languageAttr = code.getAttribute("data-language");
        outerHTML = pre.outerHTML;
      },
      { discrete: true },
    );
    expect(tagName).toBe("PRE");
    expect(codeTagName).toBe("CODE");
    expect(codeText).toBe("const x = 1;");
    expect(languageAttr).toBe("typescript");
    expect(outerHTML).toContain("const x = 1;");
  });

  test("setCode/setLanguage mutate a writable clone visible to later reads", () => {
    let code = "";
    let language = "";
    editor.update(
      () => {
        const node = $createCodeBlockNode("old", "plaintext");
        node.setCode("new code");
        node.setLanguage("rust");
        code = node.getCode();
        language = node.getLanguage();
      },
      { discrete: true },
    );
    expect(code).toBe("new code");
    expect(language).toBe("rust");
  });

  test("$isCodeBlockNode narrows only CodeBlockNode instances", () => {
    let isCode = false;
    let isDivider = false;
    let isNull = false;
    let isUndefined = false;
    editor.update(
      () => {
        const code = $createCodeBlockNode();
        const divider = $createDividerNode();
        isCode = $isCodeBlockNode(code);
        isDivider = $isCodeBlockNode(divider);
        isNull = $isCodeBlockNode(null);
        isUndefined = $isCodeBlockNode(undefined);
      },
      { discrete: true },
    );
    expect(isCode).toBe(true);
    expect(isDivider).toBe(false);
    expect(isNull).toBe(false);
    expect(isUndefined).toBe(false);
  });
});

describe("DividerNode", () => {
  test("getType returns 'divider'", () => {
    expect(DividerNode.getType()).toBe("divider");
  });

  test("clone preserves key across a new instance", () => {
    let sameKey = false;
    let differentInstance = false;
    editor.update(
      () => {
        const original = $createDividerNode();
        const cloned = DividerNode.clone(original);
        sameKey = cloned.__key === original.__key;
        differentInstance = cloned !== original;
      },
      { discrete: true },
    );
    expect(sameKey).toBe(true);
    expect(differentInstance).toBe(true);
  });

  test("exportJSON / importJSON round trip preserves type and version", () => {
    let type = "";
    let version = -1;
    let importedIsDivider = false;
    editor.update(
      () => {
        const original = $createDividerNode();
        const json = original.exportJSON();
        type = json.type;
        version = json.version;
        const imported = DividerNode.importJSON(json);
        importedIsDivider = $isDividerNode(imported);
      },
      { discrete: true },
    );
    expect(type).toBe("divider");
    expect(version).toBe(1);
    expect(importedIsDivider).toBe(true);
  });

  test("createDOM returns a div element", () => {
    let tagName = "";
    editor.update(
      () => {
        tagName = $createDividerNode().createDOM(FAKE_EDITOR_CONFIG).tagName;
      },
      { discrete: true },
    );
    expect(tagName).toBe("DIV");
  });

  test("updateDOM always returns false", () => {
    let result: unknown;
    editor.update(
      () => {
        result = $createDividerNode().updateDOM();
      },
      { discrete: true },
    );
    expect(result).toBe(false);
  });

  test("isInline returns false", () => {
    let result: unknown;
    editor.update(
      () => {
        result = $createDividerNode().isInline();
      },
      { discrete: true },
    );
    expect(result).toBe(false);
  });

  test("exportDOM produces a plain <hr> element", () => {
    let tagName = "";
    editor.update(
      () => {
        const { element } = $createDividerNode().exportDOM(editor);
        tagName = (element as HTMLElement).tagName;
      },
      { discrete: true },
    );
    expect(tagName).toBe("HR");
  });

  test("decorate() renders a themed <hr> rule", () => {
    let jsx: ReturnType<DividerNode["decorate"]> | undefined;
    editor.update(
      () => {
        jsx = $createDividerNode().decorate();
      },
      { discrete: true },
    );
    const { container } = render(jsx as NonNullable<typeof jsx>);
    const hr = container.querySelector("hr");
    expect(hr).not.toBeNull();
  });

  test("$isDividerNode narrows only DividerNode instances", () => {
    let isDivider = false;
    let isCode = false;
    let isNull = false;
    let isUndefined = false;
    editor.update(
      () => {
        const divider = $createDividerNode();
        const code = $createCodeBlockNode();
        isDivider = $isDividerNode(divider);
        isCode = $isDividerNode(code);
        isNull = $isDividerNode(null);
        isUndefined = $isDividerNode(undefined);
      },
      { discrete: true },
    );
    expect(isDivider).toBe(true);
    expect(isCode).toBe(false);
    expect(isNull).toBe(false);
    expect(isUndefined).toBe(false);
  });
});
