// src/modules/documents/blocks.ts — the serialisable block-payload shape stored in
// `concept_documents.content_blocks` (Database.md: `{"root":{"type":"root","children":[]}}`,
// `CHECK (content_blocks ? 'root')`) and the pure block→Markdown projection written into
// `body_markdown` in the same transaction (Implementation.md m11). This file owns the six block
// kinds the research's Lexical/Astryx editor surfaces: paragraph, heading, list, code, quote,
// divider. Every schema here is `.strict()` — an unrecognised key is exactly the kind of drift
// `document-module.ts`'s `ValidationError('document.corruptPayload')` read-back check exists to
// catch, so silently accepting extra keys would defeat that guard.
import { z } from "zod";

const headingLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

export type HeadingLevel = z.infer<typeof headingLevelSchema>;

export const paragraphBlockSchema = z
  .object({
    type: z.literal("paragraph"),
    text: z.string(),
  })
  .strict();

export const headingBlockSchema = z
  .object({
    type: z.literal("heading"),
    level: headingLevelSchema,
    text: z.string(),
  })
  .strict();

export const quoteBlockSchema = z
  .object({
    type: z.literal("quote"),
    text: z.string(),
  })
  .strict();

export const codeBlockSchema = z
  .object({
    type: z.literal("code"),
    /** `null` when the author did not select a language — never coerced to `""`. */
    language: z.string().nullable(),
    code: z.string(),
  })
  .strict();

export const listBlockSchema = z
  .object({
    type: z.literal("list"),
    ordered: z.boolean(),
    items: z.array(z.string()),
  })
  .strict();

export const dividerBlockSchema = z
  .object({
    type: z.literal("divider"),
  })
  .strict();

export const blockSchema = z.discriminatedUnion("type", [
  paragraphBlockSchema,
  headingBlockSchema,
  quoteBlockSchema,
  codeBlockSchema,
  listBlockSchema,
  dividerBlockSchema,
]);

export type ParagraphBlock = z.infer<typeof paragraphBlockSchema>;
export type HeadingBlock = z.infer<typeof headingBlockSchema>;
export type QuoteBlock = z.infer<typeof quoteBlockSchema>;
export type CodeBlock = z.infer<typeof codeBlockSchema>;
export type ListBlock = z.infer<typeof listBlockSchema>;
export type DividerBlock = z.infer<typeof dividerBlockSchema>;
export type Block = z.infer<typeof blockSchema>;

/** Mirrors Database.md's `content_blocks` default and `content_blocks ? 'root'` CHECK exactly. */
export const blockPayloadSchema = z
  .object({
    root: z
      .object({
        type: z.literal("root"),
        children: z.array(blockSchema),
      })
      .strict(),
  })
  .strict();

export type BlockPayload = z.infer<typeof blockPayloadSchema>;

export const EMPTY_BLOCK_PAYLOAD: BlockPayload = { root: { type: "root", children: [] } };

/** Renders one block as strict Markdown. Every arm is terminal, so this stays exhaustive by construction. */
export function blockToMarkdown(block: Block): string {
  switch (block.type) {
    case "paragraph":
      return `${block.text}\n\n`;
    case "heading":
      return `${"#".repeat(block.level)} ${block.text}\n\n`;
    case "quote":
      return `${block.text
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n")}\n\n`;
    case "code":
      return `\`\`\`${block.language ?? ""}\n${block.code}\n\`\`\`\n\n`;
    case "list":
      return `${block.items
        .map((item, index) => (block.ordered ? `${index + 1}. ${item}` : `- ${item}`))
        .join("\n")}\n\n`;
    case "divider":
      return "---\n\n";
  }
}

/**
 * Joins every top-level block's Markdown, in order, into `concept_documents.body_markdown`.
 * An empty block list produces the empty string rather than a lone trailing blank line.
 */
export function blocksToMarkdown(payload: BlockPayload): string {
  const body = payload.root.children.map(blockToMarkdown).join("");
  return body.length === 0 ? "" : `${body.trimEnd()}\n`;
}

/** Word count over the rendered Markdown, for `concept_documents.word_count`. */
export function countWords(markdown: string): number {
  const trimmed = markdown.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
