// src/modules/documents/crdt.ts — pure Yjs helpers over `Uint8Array` (Implementation.md m11).
// Nothing here touches the `Db` port, the network, or a live Lexical editor; every function is a
// deterministic transform of binary CRDT state, which is what lets `documents-crdt.test.ts`
// exercise real in-process `Y.Doc`s with no mocking at all.
//
// The shared type is `doc.getXmlFragment("root")`: a flat sequence of block-level `Y.XmlElement`
// nodes named after the block kind (`paragraph`, `heading`, `quote`, `code`, `list`, `divider`),
// each carrying its text as a single child `Y.XmlText` (or, for `list`, nested `listitem`
// elements). This is a deliberately simpler shared shape than the live editor's `@lexical/yjs`
// binding (which nests elements as embeds inside a root `Y.XmlText` — see `@lexical/yjs`'s
// `Bindings.ts`): this module never runs inside a Lexical `EditorState`, it only has to derive a
// search/export projection from whatever CRDT state the collaboration relay persisted, so a plain
// `Y.XmlFragment` tree — exactly what Implementation.md names — is sufficient and far easier to
// keep hermetic in tests.
//
// Construction order matters and is not optional: every `Y.XmlElement` below is pushed into its
// (already-integrated) parent *before* `setAttribute`/`push` is called on it. Doing it the other
// way around — building a detached subtree bottom-up, then attaching the finished root — is the
// natural way to write this and Yjs *works* fine, but every `setAttribute`/`push` call on a node
// that is not yet integrated into a document logs an internal
// "Invalid access: Add Yjs type to a document before reading data." straight to `console.error`
// (not a thrown exception — the call still succeeds). `vitest.setup.ts` (Implementation.md m2)
// fails the run on unexpected `console.error`, so bottom-up construction would make every round
// trip test in this module fail for a reason that has nothing to do with the data being wrong.
import * as Y from "yjs";
import { ValidationError } from "../../core/errors";
import { blockPayloadSchema, type Block, type BlockPayload } from "./blocks";

const ROOT_FRAGMENT_KEY = "root";

/** Re-exported so callers outside this file never need their own `import * as Y from "yjs"`. */
export type CrdtDoc = Y.Doc;

/** A fresh, empty document — the starting point for replaying `crdt_state` plus a new update. */
export function createDoc(): CrdtDoc {
  return new Y.Doc();
}

/** `Y.encodeStateAsUpdate(doc)` — the full merged document, what `concept_documents.crdt_state` stores. */
export function encodeStateAsUpdate(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

const VALID_HEADING_LEVELS = new Set([1, 2, 3, 4, 5, 6]);

function crdtValidationError(operation: string, detail: Record<string, unknown>, cause?: unknown): ValidationError {
  return new ValidationError("document.malformedCrdtUpdate", {
    details: { reason: "document.malformedCrdtUpdate", operation, ...detail },
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Applies a binary Yjs update to `doc` in place. Throws `ValidationError`
 * (`details.reason === "document.malformedCrdtUpdate"`) if `update` is not a well-formed Yjs
 * update — a truncated buffer, random bytes, or any input `Y.applyUpdate` itself rejects.
 */
export function applyUpdateToDoc(doc: Y.Doc, update: Uint8Array): void {
  try {
    Y.applyUpdate(doc, update);
  } catch (err) {
    throw crdtValidationError("applyUpdateToDoc", { updateLength: update.length }, err);
  }
}

/**
 * Merges any number of updates (including zero) into one update, without ever constructing a
 * `Y.Doc`. An empty list merges to the update representing an empty document, matching
 * `concept_documents.crdt_state`'s `DEFAULT '\x'::bytea` semantics once decoded.
 */
export function mergeUpdates(updates: readonly Uint8Array[]): Uint8Array {
  try {
    return Y.mergeUpdates(Array.from(updates));
  } catch (err) {
    throw crdtValidationError("mergeUpdates", { count: updates.length }, err);
  }
}

/** `Y.encodeStateVector(doc)` — what `concept_documents.crdt_state_vector` stores. */
export function encodeStateVector(doc: Y.Doc): Uint8Array {
  return Y.encodeStateVector(doc);
}

/**
 * The subset of `update` not already reflected by `stateVector` — lets a reconnecting client be
 * caught up without the server decoding the full document (Database.md `yjs_updates` purpose).
 */
export function diffUpdate(update: Uint8Array, stateVector: Uint8Array): Uint8Array {
  try {
    return Y.diffUpdate(update, stateVector);
  } catch (err) {
    throw crdtValidationError("diffUpdate", { updateLength: update.length, stateVectorLength: stateVector.length }, err);
  }
}

function textOf(el: Y.XmlElement): string {
  let text = "";
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      text += child.toString();
    }
  }
  return text;
}

function headingLevelOf(el: Y.XmlElement): 1 | 2 | 3 | 4 | 5 | 6 {
  const raw = el.getAttribute("level");
  const level = Number(raw);
  if (!VALID_HEADING_LEVELS.has(level)) {
    throw crdtValidationError("docToBlocks", { reason: "document.corruptCrdtStructure", nodeName: el.nodeName, attribute: "level", value: raw });
  }
  return level as 1 | 2 | 3 | 4 | 5 | 6;
}

function elementToBlock(node: Y.XmlElement | Y.XmlText | Y.XmlHook): Block {
  if (!(node instanceof Y.XmlElement)) {
    throw crdtValidationError("docToBlocks", { reason: "document.corruptCrdtStructure", found: node.constructor.name });
  }
  switch (node.nodeName) {
    case "paragraph":
      return { type: "paragraph", text: textOf(node) };
    case "heading":
      return { type: "heading", level: headingLevelOf(node), text: textOf(node) };
    case "quote":
      return { type: "quote", text: textOf(node) };
    case "code":
      return { type: "code", language: node.getAttribute("language") ?? null, code: textOf(node) };
    case "list":
      return {
        type: "list",
        ordered: node.getAttribute("ordered") === "true",
        items: node
          .toArray()
          .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement && child.nodeName === "listitem")
          .map(textOf),
      };
    case "divider":
      return { type: "divider" };
    default:
      throw crdtValidationError("docToBlocks", { reason: "document.corruptCrdtStructure", nodeName: node.nodeName });
  }
}

/**
 * Walks `doc`'s root `Y.XmlFragment` into the serialisable {@link BlockPayload} that
 * `concept_documents.content_blocks` stores. An empty fragment (a brand-new document) produces
 * `EMPTY_BLOCK_PAYLOAD`-shaped output. Throws `ValidationError`
 * (`details.reason === "document.corruptCrdtStructure"`) if the fragment contains a node this
 * module did not itself write (an unrecognised element name, a bare `Y.XmlText` at the top level,
 * or a heading with a missing/out-of-range `level` attribute).
 */
export function docToBlocks(doc: Y.Doc): BlockPayload {
  const fragment = doc.getXmlFragment(ROOT_FRAGMENT_KEY);
  const children = fragment.toArray().map(elementToBlock);
  return blockPayloadSchema.parse({ root: { type: "root", children } });
}

function populateBlockElement(el: Y.XmlElement, block: Block): void {
  switch (block.type) {
    case "paragraph":
      el.push([new Y.XmlText(block.text)]);
      return;
    case "heading":
      el.setAttribute("level", String(block.level));
      el.push([new Y.XmlText(block.text)]);
      return;
    case "quote":
      el.push([new Y.XmlText(block.text)]);
      return;
    case "code":
      if (block.language !== null) {
        el.setAttribute("language", block.language);
      }
      el.push([new Y.XmlText(block.code)]);
      return;
    case "list":
      el.setAttribute("ordered", block.ordered ? "true" : "false");
      for (const item of block.items) {
        const itemEl = new Y.XmlElement("listitem");
        el.push([itemEl]);
        itemEl.push([new Y.XmlText(item)]);
      }
      return;
    case "divider":
      return;
  }
}

/**
 * The inverse of {@link docToBlocks}: replaces `doc`'s root fragment's contents with `payload`.
 * Used to seed a fresh `Y.Doc` from a known block payload (tests, and a Markdown-import path that
 * needs to construct CRDT state that did not originate from a live editing session). Every
 * element is attached to its (already-integrated) parent before being populated — see the
 * module-level comment on why the order is load-bearing.
 */
export function applyBlocksToDoc(doc: Y.Doc, payload: BlockPayload): void {
  const fragment = doc.getXmlFragment(ROOT_FRAGMENT_KEY);
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }
  for (const block of payload.root.children) {
    const el = new Y.XmlElement(block.type);
    fragment.push([el]);
    populateBlockElement(el, block);
  }
}
