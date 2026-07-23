/**
 * orchestrator/phases/research.ts
 * Phase I — Research, run as a pi.dev subagent ensemble:
 *
 *   prompt-assembler  (first)  → crafts the three specialised research prompts
 *   architecture-researcher ─┐
 *   domain-researcher        ├─ run in parallel (Gemini)
 *   erd-researcher          ─┘
 *   prompt-assembler  (last)  → merges results into one huge RESEARCH.md
 *
 * Output: RESEARCH.md in the project workspace (DOMAIN.md kept as a
 * compatibility mirror), then GATE1_PENDING.
 */

import {
  type PipelineState,
  getPipeline,
  savePipeline,
  saveDesignDoc,
  pushPhaseHistory,
} from "../state";
import { generateWithGemini, friendlyGeminiError } from "../subagents/gemini";
import { getSubagentRunner } from "../subagents/pi";

interface ResearchPrompts {
  architecture: string;
  domain: string;
  erd: string;
}

function steeringNotes(state: PipelineState): string {
  const notes = (state.contextNotes || [])
    .map((n) => n.note)
    .filter((n) => !n.startsWith("[AgentDesign]"))
    .join("\n");
  return notes ? `\nAdditional steering input from the user:\n${notes}\n` : "";
}

/** Stage 0 — assemble the best prompts for the three researchers. */
async function assemblePrompts(
  state: PipelineState,
  apiKey: string,
  model: string
): Promise<{ prompts: ResearchPrompts; usedModel: string }> {
  const assemblerPrompt = `You are the Prompt Assembler subagent of the Double-Loop Orchestrator's research stage.
Craft the three best possible research prompts for the project below. Each prompt will be given to a
specialist research agent with web-scale knowledge. Make each prompt specific to THIS project — name the
domain, the likely users, the scale, and the constraints found in the objectives.

Project name: ${state.projectName}
Objectives:
${state.objectivesMarkdown}
${steeringNotes(state)}

Respond with ONLY a JSON object, no code fences:
{
  "architecture": "<prompt asking for the best architecture approach: candidate frameworks with tradeoffs, hosting, scaling, integration patterns, security posture. If the objectives do not mandate a specific web framework, the prompt MUST instruct the researcher to evaluate TanStack Start as the default choice.>",
  "domain": "<prompt asking for the best domain knowledge: terminology, actors, core workflows, business rules, compliance, edge cases>",
  "erd": "<prompt asking for the best entity relationships: entities, attributes, relations with cardinality, normalization guidance, and an example mermaid erDiagram — targeting PostgreSQL>"
}`;

  const { text, usedModel } = await generateWithGemini({ apiKey, model, prompt: assemblerPrompt });
  let jsonText = text.trim();
  const block = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block?.[1]) jsonText = block[1].trim();
  const first = jsonText.indexOf("{");
  const last = jsonText.lastIndexOf("}");
  if (first !== -1 && last > first) jsonText = jsonText.slice(first, last + 1);

  try {
    const parsed = JSON.parse(jsonText);
    if (parsed.architecture && parsed.domain && parsed.erd) {
      return { prompts: parsed as ResearchPrompts, usedModel };
    }
  } catch { /* fall through to deterministic prompts */ }

  // Deterministic prompts if the assembler response was unusable — still
  // project-specific because they embed the objectives verbatim.
  const base = `Project: ${state.projectName}\nObjectives:\n${state.objectivesMarkdown}\n${steeringNotes(state)}`;
  return {
    prompts: {
      architecture: `${base}\nResearch the best architecture approach for this project: candidate frameworks with tradeoffs (if no specific framework is mandated by the objectives, evaluate TanStack Start as the default choice), hosting, scaling, integration patterns, and security posture. Be concrete and opinionated; recommend one approach.`,
      domain: `${base}\nResearch the best domain knowledge for this project: terminology, actors and roles, core workflows, business rules, compliance requirements, and edge cases a builder must handle.`,
      erd: `${base}\nResearch the best entity relationships for this project's data model, targeting PostgreSQL: entities with attributes and types, relations with cardinality, normalization guidance, and include a mermaid erDiagram block.`,
    },
    usedModel,
  };
}

/** Full research orchestration. Exported for init route + Gate-1 "research further". */
export async function runResearchBackground(pipelineId: string): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const apiKey = state.config?.providers?.research?.apiKey || process.env.GEMINI_API_KEY || "";
    const modelName = state.config?.providers?.research?.model || "deep-research-preview-04-2026";
    if (!apiKey) throw new Error("Gemini API Key missing for research phase.");

    const runner = await getSubagentRunner(state.config);

    // Stage 0: best-prompt assembly
    const { prompts, usedModel } = await assemblePrompts(state, apiKey, modelName);

    // Stage 1: three specialist researchers in parallel
    const results = await runner.runParallel([
      {
        name: "architecture-researcher",
        mission: "Best architecture approach",
        run: async () => (await generateWithGemini({ apiKey, model: modelName, prompt:
          `You are the Architecture Research subagent. Produce a deep, citation-rich markdown research report.\n${prompts.architecture}\nFormat strictly as Markdown (no outer code fence). Start at heading level 3 (###).` })).text,
      },
      {
        name: "domain-researcher",
        mission: "Best domain knowledge",
        run: async () => (await generateWithGemini({ apiKey, model: modelName, prompt:
          `You are the Domain Knowledge Research subagent. Produce a deep markdown research report.\n${prompts.domain}\nFormat strictly as Markdown (no outer code fence). Start at heading level 3 (###).` })).text,
      },
      {
        name: "erd-researcher",
        mission: "Best entity relationships (ERD, PostgreSQL)",
        run: async () => (await generateWithGemini({ apiKey, model: modelName, prompt:
          `You are the ERD Research subagent. Produce a deep markdown research report targeting PostgreSQL, including a \`\`\`mermaid erDiagram block.\n${prompts.erd}\nFormat strictly as Markdown (no outer code fence). Start at heading level 3 (###).` })).text,
      },
    ]);

    const failures = results.filter((r) => !r.ok);
    if (failures.length === results.length) {
      throw new Error(`All research subagents failed: ${failures.map((f) => `${f.name}: ${f.error}`).join("; ")}`);
    }

    const section = (name: string) => results.find((r) => r.name === name);
    const arch = section("architecture-researcher");
    const domain = section("domain-researcher");
    const erd = section("erd-researcher");

    // Stage 2: assembler merges into one huge document
    const assemblyPrompt = `You are the Prompt Assembler subagent, now acting as the final research editor.
Merge the three research reports below into ONE cohesive Domain Research Document for the project
"${state.projectName}". Write an "## Executive Summary" (10-20 bullet points covering the most important
findings and the recommended stack — default to TanStack Start if no other framework was mandated),
deduplicate overlapping content, keep ALL substantive detail, and cross-reference sections.
Respond with ONLY the merged markdown body (no outer code fence). Do not repeat the reports verbatim
headers; organize as: Executive Summary, Architecture Research, Domain Knowledge, Entity Relationships & Data.

--- ARCHITECTURE REPORT ---
${arch?.ok ? arch.value : `(architecture researcher failed: ${arch?.error})`}

--- DOMAIN REPORT ---
${domain?.ok ? domain.value : `(domain researcher failed: ${domain?.error})`}

--- ERD REPORT ---
${erd?.ok ? erd.value : `(erd researcher failed: ${erd?.error})`}`;

    let merged: string;
    try {
      merged = (await generateWithGemini({ apiKey, model: modelName, prompt: assemblyPrompt })).text;
    } catch (e: any) {
      // Assembly is a quality step; if it fails, concatenate the raw reports
      // (clearly labeled) rather than losing the successful research.
      console.warn("[Research] Assembly step failed, concatenating raw reports:", e.message);
      merged = [
        `## Architecture Research\n\n${arch?.ok ? arch.value : `_failed: ${arch?.error}_`}`,
        `## Domain Knowledge\n\n${domain?.ok ? domain.value : `_failed: ${domain?.error}_`}`,
        `## Entity Relationships & Data\n\n${erd?.ok ? erd.value : `_failed: ${erd?.error}_`}`,
      ].join("\n\n");
    }

    const generatedAt = new Date().toISOString();
    const frontMatter =
      `# Domain Research — ${state.projectName}\n\n` +
      `> Generated: ${generatedAt}\n` +
      `> Subagent runner: ${runner.kind === "pi-sdk" ? "pi.dev SDK" : "local runner (pi SDK not installed)"}\n` +
      `> Research model: ${usedModel}\n` +
      `> Subagents: prompt-assembler, architecture-researcher, domain-researcher, erd-researcher\n` +
      (failures.length ? `> ⚠ Partial: ${failures.map((f) => f.name).join(", ")} failed\n` : "") +
      `\n`;

    const markdown = frontMatter + merged;

    const fresh = await getPipeline(pipelineId);
    if (!fresh || fresh.phase === "ABORTED") return;

    fresh.researchMeta = {
      runner: runner.kind,
      subagents: ["prompt-assembler", "architecture-researcher", "domain-researcher", "erd-researcher"],
      model: usedModel,
      generatedAt,
    };
    fresh.domainDocument = {
      markdown,
      citations: [{ url: "https://ai.google.dev", title: "Google Gemini Research" }],
    };
    await saveDesignDoc(fresh, "research", markdown);

    fresh.phase = "GATE1_PENDING";
    pushPhaseHistory(fresh, "GATE1_PENDING");
    fresh.lastTransitionAt = new Date().toISOString();
    fresh.activeGate = {
      gateId: `gate-${crypto.randomUUID()}`,
      kind: "DOMAIN_DOCUMENT",
      exhibits: [markdown],
    };
    await savePipeline(fresh);
    console.log(`[Research] Completed for pipeline ${pipelineId} (runner=${runner.kind})`);
  } catch (err: any) {
    const s = await getPipeline(pipelineId);
    if (!s) return;
    s.phase = "FAILED";
    pushPhaseHistory(s, "FAILED");
    s.error = friendlyGeminiError(err.message || String(err));
    s.lastTransitionAt = new Date().toISOString();
    await savePipeline(s);
  }
}
