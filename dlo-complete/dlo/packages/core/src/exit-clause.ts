/**
 * The deterministic, machine-evaluable exit-clause DSL.
 * Ref: §12.2 of the architecture document.
 */

import { z } from "zod";

export const ExitClauseBaseSchema = z.object({
  clauseId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  description: z.string().min(4),
});

export const CommandClauseSchema = ExitClauseBaseSchema.extend({
  kind: z.literal("command"),
  argv: z.array(z.string()).min(1),
  cwd: z.enum(["workspace", "backend", "frontend"]).default("workspace"),
  expect: z.object({
    exitCode: z.number().int().default(0),
    stdoutMatches: z.string().optional(),
    stderrMaxBytes: z.number().int().optional(),
  }),
  timeoutMs: z.number().int().min(1_000).max(1_800_000),
});

export const HttpProbeClauseSchema = ExitClauseBaseSchema.extend({
  kind: z.literal("httpProbe"),
  serviceUnderTest: z.object({
    startArgv: z.array(z.string()).min(1),
    readyLogPattern: z.string(),
    startupTimeoutMs: z.number().int(),
  }),
  request: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string(),
    headers: z.record(z.string(), z.string()).default({}),
    bodyArtifact: z.object({
      sha256: z.string(),
      mediaType: z.string(),
    }).optional(),
  }),
  expect: z.object({
    status: z.number().int(),
    jsonSchemaArtifact: z.object({
      sha256: z.string(),
      mediaType: z.string(),
    }).optional(),
  }),
  timeoutMs: z.number().int(),
});

export const SqlAssertionClauseSchema = ExitClauseBaseSchema.extend({
  kind: z.literal("sqlAssertion"),
  query: z.string().min(1),
  expect: z.object({
    rowCountAtLeast: z.number().int().optional(),
    singleValueEquals: z.string().optional(),
  }),
  timeoutMs: z.number().int(),
});

export const FileAssertionClauseSchema = ExitClauseBaseSchema.extend({
  kind: z.literal("fileAssertion"),
  glob: z.string(),
  mustExist: z.boolean(),
  contentMatches: z.string().optional(),
  contentForbids: z.string().optional(),
});

export const ExitClauseSchema = z.discriminatedUnion("kind", [
  CommandClauseSchema,
  HttpProbeClauseSchema,
  SqlAssertionClauseSchema,
  FileAssertionClauseSchema,
]);

export type ExitClause = z.infer<typeof ExitClauseSchema>;
export type CommandClause = z.infer<typeof CommandClauseSchema>;
export type HttpProbeClause = z.infer<typeof HttpProbeClauseSchema>;
export type SqlAssertionClause = z.infer<typeof SqlAssertionClauseSchema>;
export type FileAssertionClause = z.infer<typeof FileAssertionClauseSchema>;

export function clauseKind(clause: ExitClause): string {
  return clause.kind;
}

export function allClauseKinds(): readonly string[] {
  return ["command", "httpProbe", "sqlAssertion", "fileAssertion"];
}
