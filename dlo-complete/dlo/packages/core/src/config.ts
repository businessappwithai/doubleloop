import { z } from "zod";

export const DloConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    objectivesPath: z.string(),
    groundingPaths: z.array(z.string()).default([]),
    workspace: z.object({
      backendDir: z.string().default("backend"),
      frontendDir: z.string().default("frontend"),
    }),
  }),
  providers: z.object({
    research: z.object({
      vendor: z.literal("gemini-deep-research"),
      model: z.string().default("deep-research-preview-04-2026"),
      apiKeyEnv: z.string().default("GEMINI_API_KEY"),
      apiKey: z.string().optional(),
      mcpServers: z.array(
        z.object({
          name: z.string(),
          url: z.string().url(),
          authorizationHeaderEnv: z.string().optional(),
        })
      ).default([]),
      maxTransientRetries: z.number().int().default(6),
    }),
    planner: z.object({
      vendor: z.literal("claude-code"),
      model: z.string().optional(),
      binPath: z.string().default("claude"),
      maxTurns: z.number().int().default(60),
      maxValidationRetries: z.number().int().default(2),
      apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
      apiKey: z.string().optional(),
    }),
    supervisor: z.object({
      vendor: z.literal("claude-code"),
      model: z.string().optional(),
      evaluationTimeoutMs: z.number().int().default(900_000),
      apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
      apiKey: z.string().optional(),
    }),
    executor: z.object({
      vendor: z.literal("codewhale"),
      model: z.string().optional(),
      maxConcurrent: z.number().int().min(1).max(20).default(8),
      configTomlPath: z.string().default("~/.codewhale/config.toml"),
      apiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
      apiKey: z.string().optional(),
    }),
    harness: z.object({
      vendor: z.literal("pi"),
      model: z.string().optional(),
      sdkPackage: z.literal("@earendil-works/pi-coding-agent"),
      subagentsExtension: z.enum(["@gotgenes/pi-subagents", "@tintinweb/pi-subagents"]),
      apiKeyEnv: z.string().default("PI_API_KEY"),
      apiKey: z.string().optional(),
    }),
  }),
  hitl: z.object({
    transports: z.array(z.enum(["tui", "http-webhook"])).min(1).default(["tui"]),
    gateTtlMs: z.number().int().optional(),
    webhook: z.object({
      url: z.string().url(),
      secretEnv: z.string(),
      listenPort: z.number().int(),
    }).optional(),
  }),
  execution: z.object({
    trustLevel: z.enum(["scoped", "autonomous"]).default("scoped"),
  }),
  budgets: z.object({
    usd: z.number().positive(),
    tokens: z.number().int().positive(),
    wallClockMs: z.number().int().positive(),
    maxSpawnDepth: z.number().int().default(2),
    warnAtFraction: z.number().min(0.5).max(0.95).default(0.8),
  }),
  verification: z.object({
    evidenceMaxBytes: z.number().int().default(16_384),
    pgImage: z.string().default("postgres:17-alpine"),
  }),
  journal: z.object({
    snapshotEvery: z.number().int().default(500),
    segmentMaxBytes: z.number().int().default(67_108_864),
  }),
  resilience: z.object({
    compactAtFraction: z.number().default(0.75),
  }),
  plugins: z.array(z.string()).default([]),
});

export type DloConfig = z.infer<typeof DloConfigSchema>;
