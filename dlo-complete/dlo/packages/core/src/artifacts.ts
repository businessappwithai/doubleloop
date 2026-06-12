/**
 * Content-addressed artifacts stored under .dlo/artifacts/<sha256>/
 * Immutable once written; referred to by sha256 hash throughout the system.
 */

import { z } from "zod";

export const ArtifactRefSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  label: z.string().min(1),
  storedAt: z.string().datetime(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const DomainDocumentSchema = z.object({
  markdown: ArtifactRefSchema,
  citations: z.array(z.object({
    url: z.string().url(),
    title: z.string(),
  })).min(1),
  visualizations: z.array(ArtifactRefSchema).default([]),
  geminiInteractionId: z.string().min(1),
  completedAt: z.string().datetime(),
});
export type DomainDocument = z.infer<typeof DomainDocumentSchema>;

export const TripartitePlanRefsSchema = z.object({
  ceoPlan: ArtifactRefSchema,
  architecturePlan: ArtifactRefSchema,
  engineeringPlan: ArtifactRefSchema,
  completedAt: z.string().datetime(),
});
export type TripartitePlanRefs = z.infer<typeof TripartitePlanRefsSchema>;

// Helper to extract readable content from an artifact reference
export async function resolveArtifact(ref: ArtifactRef, artifactDir: string): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  const path = `${artifactDir}/${ref.sha256}/data`;
  return readFile(path);
}

export async function resolveArtifactText(ref: ArtifactRef, artifactDir: string): Promise<string> {
  const buf = await resolveArtifact(ref, artifactDir);
  return buf.toString("utf-8");
}
