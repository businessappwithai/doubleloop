// tests/documents-crdt.test.ts — module m11 (documents). Pure Yjs helpers over real, in-process
// `Y.Doc`s: no mocking of `yjs` itself, since the whole point of these functions is to be a thin,
// deterministic wrapper around real CRDT merge semantics. `vitest.setup.ts` turns any unexpected
// `console.error` into a hard failure, which is exactly the tripwire for the "attach before
// populate" ordering rule `crdt.ts`'s module comment documents — a regression there fails every
// test in this file, not just the one that happens to assert on it.
import { describe, test, expect } from "vitest";
import * as Y from "yjs";
import {
  applyBlocksToDoc,
  applyUpdateToDoc,
  createDoc,
  diffUpdate,
  docToBlocks,
  encodeStateAsUpdate,
  encodeStateVector,
  mergeUpdates,
} from "../src/modules/documents/crdt";
import { EMPTY_BLOCK_PAYLOAD, type BlockPayload } from "../src/modules/documents/blocks";
import { ValidationError } from "../src/core/errors";

function pushParagraph(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment("root");
  const el = new Y.XmlElement("paragraph");
  fragment.push([el]);
  el.push([new Y.XmlText(text)]);
}

describe("applyUpdateToDoc / concurrent convergence", () => {
  test("two in-process Y.Docs converge to identical state after concurrent inserts", () => {
    const docA = createDoc();
    const docB = createDoc();

    pushParagraph(docA, "from A");
    pushParagraph(docB, "from B");

    const updateFromA = encodeStateAsUpdate(docA);
    const updateFromB = encodeStateAsUpdate(docB);

    // Cross-apply: each doc receives the other's concurrent insert.
    applyUpdateToDoc(docA, updateFromB);
    applyUpdateToDoc(docB, updateFromA);

    const blocksA = docToBlocks(docA);
    const blocksB = docToBlocks(docB);

    expect(blocksA).toEqual(blocksB);
    expect(blocksA.root.children).toHaveLength(2);
    expect(blocksA.root.children.map((b) => (b.type === "paragraph" ? b.text : null)).sort()).toEqual([
      "from A",
      "from B",
    ]);
  });

  test("throws ValidationError for a malformed update", () => {
    const doc = createDoc();
    let caught: unknown;
    try {
      applyUpdateToDoc(doc, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const err = caught as ValidationError;
    expect(err.details["reason"]).toBe("document.malformedCrdtUpdate");
    expect(err.details["operation"]).toBe("applyUpdateToDoc");
  });

  test("throws ValidationError for a truncated update", () => {
    expect(() => applyUpdateToDoc(createDoc(), new Uint8Array([255]))).toThrow(ValidationError);
  });
});

describe("mergeUpdates", () => {
  test("merges an empty update list without throwing", () => {
    const merged = mergeUpdates([]);
    expect(merged).toBeInstanceOf(Uint8Array);

    const doc = createDoc();
    applyUpdateToDoc(doc, merged);
    expect(docToBlocks(doc)).toEqual(EMPTY_BLOCK_PAYLOAD);
  });

  test("merges multiple sequential updates into one that reproduces the same document", () => {
    const source = createDoc();
    const updates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => {
      updates.push(update);
    });

    pushParagraph(source, "one");
    source.getXmlFragment("root").push([new Y.XmlElement("divider")]);

    expect(updates.length).toBeGreaterThanOrEqual(2);

    const merged = mergeUpdates(updates);

    const target = createDoc();
    applyUpdateToDoc(target, merged);
    expect(docToBlocks(target)).toEqual(docToBlocks(source));
  });
});

describe("encodeStateVector / diffUpdate", () => {
  test("diffing an update against its own state vector yields no further changes", () => {
    const doc = createDoc();
    pushParagraph(doc, "hello");
    const update = encodeStateAsUpdate(doc);
    const stateVector = encodeStateVector(doc);

    const diff = diffUpdate(update, stateVector);

    const replay = createDoc();
    applyUpdateToDoc(replay, diff);
    expect(docToBlocks(replay)).toEqual(EMPTY_BLOCK_PAYLOAD);
  });

  test("diffing against an empty state vector reproduces the full update", () => {
    const doc = createDoc();
    pushParagraph(doc, "hello");
    const update = encodeStateAsUpdate(doc);
    const emptyStateVector = encodeStateVector(createDoc());

    const diff = diffUpdate(update, emptyStateVector);

    const replay = createDoc();
    applyUpdateToDoc(replay, diff);
    expect(docToBlocks(replay)).toEqual(docToBlocks(doc));
  });

  test("diffUpdate throws ValidationError for a malformed update", () => {
    expect(() => diffUpdate(new Uint8Array([255, 255, 255]), new Uint8Array([0]))).toThrow(ValidationError);
  });
});

describe("docToBlocks / applyBlocksToDoc round trip", () => {
  test("an empty document round-trips to EMPTY_BLOCK_PAYLOAD", () => {
    const doc = createDoc();
    expect(docToBlocks(doc)).toEqual(EMPTY_BLOCK_PAYLOAD);

    applyBlocksToDoc(doc, EMPTY_BLOCK_PAYLOAD);
    expect(docToBlocks(doc)).toEqual(EMPTY_BLOCK_PAYLOAD);
  });

  test.each<[string, BlockPayload]>([
    ["paragraph", { root: { type: "root", children: [{ type: "paragraph", text: "hello world" }] } }],
    ["heading", { root: { type: "root", children: [{ type: "heading", level: 3, text: "Title" }] } }],
    ["quote", { root: { type: "root", children: [{ type: "quote", text: "a witty remark" }] } }],
    [
      "code",
      {
        root: { type: "root", children: [{ type: "code", language: "ts", code: "const x = 1;" }] },
      },
    ],
    [
      "code with no language",
      { root: { type: "root", children: [{ type: "code", language: null, code: "plain text" }] } },
    ],
    [
      "list",
      {
        root: {
          type: "root",
          children: [{ type: "list", ordered: true, items: ["first", "second", "third"] }],
        },
      },
    ],
    ["divider", { root: { type: "root", children: [{ type: "divider" }] } }],
  ])("round-trips a %s block through Y.Doc unchanged", (_name, payload) => {
    const doc = createDoc();
    applyBlocksToDoc(doc, payload);
    expect(docToBlocks(doc)).toEqual(payload);
  });

  test("round-trips every block type together, in order, through a binary update", () => {
    const payload: BlockPayload = {
      root: {
        type: "root",
        children: [
          { type: "heading", level: 1, text: "Doc Title" },
          { type: "paragraph", text: "intro paragraph" },
          { type: "list", ordered: false, items: ["a", "b"] },
          { type: "code", language: "sql", code: "SELECT 1;" },
          { type: "quote", text: "quoted" },
          { type: "divider" },
        ],
      },
    };

    const source = createDoc();
    applyBlocksToDoc(source, payload);
    const update = encodeStateAsUpdate(source);

    const target = createDoc();
    applyUpdateToDoc(target, update);

    expect(docToBlocks(target)).toEqual(payload);
  });

  test("applyBlocksToDoc replaces prior content rather than appending", () => {
    const doc = createDoc();
    applyBlocksToDoc(doc, { root: { type: "root", children: [{ type: "divider" }] } });
    applyBlocksToDoc(doc, { root: { type: "root", children: [{ type: "paragraph", text: "replaced" }] } });

    expect(docToBlocks(doc)).toEqual({
      root: { type: "root", children: [{ type: "paragraph", text: "replaced" }] },
    });
  });

  test("docToBlocks throws ValidationError for an unrecognised element name", () => {
    const doc = createDoc();
    const fragment = doc.getXmlFragment("root");
    fragment.push([new Y.XmlElement("not-a-known-block")]);

    let caught: unknown;
    try {
      docToBlocks(doc);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details["reason"]).toBe("document.corruptCrdtStructure");
  });

  test("docToBlocks throws ValidationError for a heading with a missing level attribute", () => {
    const doc = createDoc();
    const fragment = doc.getXmlFragment("root");
    const el = new Y.XmlElement("heading");
    fragment.push([el]);
    el.push([new Y.XmlText("no level set")]);

    expect(() => docToBlocks(doc)).toThrow(ValidationError);
  });

  test("docToBlocks throws ValidationError for a heading with an out-of-range level", () => {
    const doc = createDoc();
    const fragment = doc.getXmlFragment("root");
    const el = new Y.XmlElement("heading");
    fragment.push([el]);
    el.setAttribute("level", "9");
    el.push([new Y.XmlText("bad level")]);

    expect(() => docToBlocks(doc)).toThrow(ValidationError);
  });
});
