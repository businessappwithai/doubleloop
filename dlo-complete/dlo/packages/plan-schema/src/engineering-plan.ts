import { z } from "zod";
import { ExitClauseSchema } from "@dlo/core";

export const StackTargetSchema = z.enum(["rust-axum", "postgresql", "tanstack-start", "cross-cutting"]);
export type StackTarget = z.infer<typeof StackTargetSchema>;

export const EngineeringModuleSchema = z.object({
  moduleId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  title: z.string().min(4),
  stackTarget: StackTargetSchema,
  prompt: z.string().min(40),
  dependsOn: z.array(z.string()).default([]),
  estimatedComplexity: z.enum(["trivial", "standard", "complex"]),
  maxAttempts: z.number().int().min(1).max(10).default(4),
  exitClauses: z.array(ExitClauseSchema).min(1),
  touches: z.array(z.string()).min(1),
});
export type EngineeringModule = z.infer<typeof EngineeringModuleSchema>;

export const EngineeringPlanSchema = z.object({
  planVersion: z.literal(1),
  generatedBy: z.string(),
  modules: z.array(EngineeringModuleSchema).min(1),
}).superRefine((data, ctx) => {
  const moduleIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (let i = 0; i < data.modules.length; i++) {
    const mod = data.modules[i]!;
    if (moduleIds.has(mod.moduleId)) {
      duplicateIds.add(mod.moduleId);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate moduleId found: ${mod.moduleId}`,
        path: ["modules", i, "moduleId"],
      });
    }
    moduleIds.add(mod.moduleId);
  }

  // Verify all dependsOn references exist
  const adj = new Map<string, string[]>();
  for (let i = 0; i < data.modules.length; i++) {
    const mod = data.modules[i]!;
    adj.set(mod.moduleId, []);
    for (let j = 0; j < mod.dependsOn.length; j++) {
      const dep = mod.dependsOn[j]!;
      if (!moduleIds.has(dep)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Module ${mod.moduleId} depends on unresolved moduleId: ${dep}`,
          path: ["modules", i, "dependsOn", j],
        });
      }
    }
  }

  if (duplicateIds.size > 0) return;

  // Build adjacency list (edges from dependencies to dependent modules)
  const inDegree = new Map<string, number>();
  for (const mod of data.modules) {
    inDegree.set(mod.moduleId, 0);
  }

  for (const mod of data.modules) {
    for (const dep of mod.dependsOn) {
      const list = adj.get(dep) || [];
      list.push(mod.moduleId);
      adj.set(dep, list);
      inDegree.set(mod.moduleId, (inDegree.get(mod.moduleId) || 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  let processedCount = 0;
  while (queue.length > 0) {
    const curr = queue.shift()!;
    processedCount++;
    const neighbors = adj.get(curr) || [];
    for (const neighbor of neighbors) {
      const deg = (inDegree.get(neighbor) || 0) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (processedCount < data.modules.length) {
    // Find the cycle path using DFS
    const visited = new Set<string>();
    const recStack: string[] = [];
    const container = { cyclePath: null as string[] | null };

    function dfs(node: string): boolean {
      if (recStack.includes(node)) {
        const idx = recStack.indexOf(node);
        container.cyclePath = [...recStack.slice(idx), node];
        return true;
      }
      if (visited.has(node)) {
        return false;
      }

      visited.add(node);
      recStack.push(node);
      const deps = data.modules.find((m) => m.moduleId === node)?.dependsOn || [];
      for (const dep of deps) {
        if (dfs(dep)) return true;
      }
      recStack.pop();
      return false;
    }

    for (const mod of data.modules) {
      if (dfs(mod.moduleId)) {
        break;
      }
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Cyclic dependencies detected: ${container.cyclePath ? container.cyclePath.join(" -> ") : "unknown cycle"}`,
      path: ["modules"],
    });
  }
});

export type EngineeringPlan = z.infer<typeof EngineeringPlanSchema>;
