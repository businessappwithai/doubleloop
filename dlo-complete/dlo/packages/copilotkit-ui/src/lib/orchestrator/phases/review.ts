/**
 * orchestrator/phases/review.ts
 * Phase II.b — CEO review of the three design documents.
 *
 * A pi.dev subagent invokes Claude Code with the gstack skill
 * `/plan-ceo-review <doc>` (plan mode). If the gstack skill is not installed
 * on the host, a built-in CEO-review prompt with the same rubric runs instead
 * and the output is LABELED "built-in" — never a silent substitute.
 *
 * Output per document: <Doc>.review.md on disk + structured suggestions in
 * state.reviews, then GATE2_PENDING (kind DESIGN_REVIEW).
 */

import { join } from "node:path";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import {
  type PipelineState,
  type DocumentReview,
  type ReviewSuggestion,
  type DesignDocKey,
  DOC_FILENAMES,
  REVIEW_FILENAMES,
  getPipeline,
  savePipeline,
  pushPhaseHistory,
  writeWorkspaceMarkdown,
} from "../state";
import { spawnClaudeAgent, claudeAuthFromConfig } from "../subagents/claude";
import { getSubagentRunner } from "../subagents/pi";

const REVIEW_TIMEOUT_MS = 10 * 60_000;

type ReviewableDoc = Exclude<DesignDocKey, "research">;
const REVIEWABLE_DOCS: ReviewableDoc[] = ["architecture", "database", "implementation"];

async function gstackSkillAvailable(): Promise<boolean> {
  try {
    await access(join(homedir(), ".claude/skills/gstack/SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

const SUGGESTION_FORMAT = `Structure your review as a numbered list of suggestions, EXACTLY in this format
(one block per suggestion, severity is one of high|medium|low):

## Suggestion 1 — <short title> [severity: high]
**Rationale:** <why this matters>
**Proposed change:** <the concrete improvement — quote the section to change and give the improved text>

End with a one-paragraph "## Overall Verdict".`;

function builtInReviewPrompt(doc: ReviewableDoc, markdown: string, projectName: string): string {
  return `You are a CEO-level plan reviewer (acting in place of the gstack /plan-ceo-review skill, which is
not installed on this host). Review the ${DOC_FILENAMES[doc]} document of project "${projectName}" with a
CEO's rubric: strategy and scope (is this the right thing to build, is anything over/under-scoped?),
risks and blind spots, sequencing, and concrete improvements. Be specific and actionable — vague advice
is worthless.

${SUGGESTION_FORMAT}

The document under review:

${markdown}`;
}

function gstackReviewPrompt(doc: ReviewableDoc): string {
  return `/plan-ceo-review ${DOC_FILENAMES[doc]}

Review the plan document ${DOC_FILENAMES[doc]} in this workspace using the plan-ceo-review rubric.
${SUGGESTION_FORMAT}`;
}

/** Parse "## Suggestion N — title [severity: x]" blocks into structured suggestions. */
export function parseSuggestions(rawMarkdown: string): ReviewSuggestion[] {
  const suggestions: ReviewSuggestion[] = [];
  const blockRe = /^##\s*Suggestion\s+(\d+)\s*[—-]\s*(.+?)\s*(?:\[severity:\s*(high|medium|low)\s*\])?\s*$/gim;
  const matches = [...rawMarkdown.matchAll(blockRe)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : rawMarkdown.length;
    const body = rawMarkdown.slice(start, end).trim();
    const rationale = body.match(/\*\*Rationale:?\*\*:?\s*([\s\S]*?)(?=\*\*Proposed change|$)/i)?.[1]?.trim() || "";
    const proposed = body.match(/\*\*Proposed change:?\*\*:?\s*([\s\S]*?)(?=^##\s|$)/im)?.[1]?.trim() || body;
    suggestions.push({
      id: `s${m[1]}`,
      title: m[2]?.trim() || `Suggestion ${m[1]}`,
      severity: (m[3]?.toLowerCase() as ReviewSuggestion["severity"]) || "medium",
      rationale,
      proposedChange: proposed,
      status: "open",
    });
  }
  return suggestions;
}

/** Review a single document. Used by the phase and by the per-doc re-review API. */
export async function reviewDocument(
  state: PipelineState,
  doc: ReviewableDoc
): Promise<DocumentReview> {
  const markdown = state.designDocs?.[doc]?.markdown;
  if (!markdown) throw new Error(`Cannot review ${doc}: document not generated yet.`);

  const reviewerModel = state.config?.providers?.reviewer?.model
    || state.config?.providers?.planner?.model
    || "claude-sonnet-5";
  const { auth, apiKey } = claudeAuthFromConfig(state.config);
  const useGstack = await gstackSkillAvailable();

  const rawMarkdown = await spawnClaudeAgent({
    prompt: useGstack
      ? gstackReviewPrompt(doc)
      : builtInReviewPrompt(doc, markdown, state.projectName),
    model: reviewerModel,
    cwd: state.workspaceDir,
    permissionMode: "plan",
    auth,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: REVIEW_TIMEOUT_MS,
  });

  const review: DocumentReview = {
    reviewer: useGstack ? "gstack/plan-ceo-review" : "built-in",
    rawMarkdown,
    suggestions: parseSuggestions(rawMarkdown),
    reviewedAt: new Date().toISOString(),
  };

  await writeWorkspaceMarkdown(
    state.workspaceDir,
    REVIEW_FILENAMES[doc],
    `# CEO Review — ${DOC_FILENAMES[doc]}\n\n> Reviewer: ${review.reviewer}\n> Reviewed: ${review.reviewedAt}\n\n${rawMarkdown}`
  );
  return review;
}

export async function runCeoReviewBackground(pipelineId: string): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const runner = await getSubagentRunner(state.config);
    console.log(`[CEO-Review] Reviewing 3 documents (runner=${runner.kind})`);

    const results = await runner.runParallel(
      REVIEWABLE_DOCS.map((doc) => ({
        name: `ceo-reviewer:${doc}`,
        mission: `/plan-ceo-review ${DOC_FILENAMES[doc]}`,
        run: () => reviewDocument(state, doc),
      }))
    );

    const fresh = await getPipeline(pipelineId);
    if (!fresh || fresh.phase === "ABORTED" || fresh.phase === "FAILED") return;

    if (!fresh.reviews) fresh.reviews = {};
    const failures: string[] = [];
    for (let i = 0; i < REVIEWABLE_DOCS.length; i++) {
      const doc = REVIEWABLE_DOCS[i]!;
      const r = results.find((x) => x.name === `ceo-reviewer:${doc}`);
      if (r?.ok && r.value) {
        fresh.reviews[doc] = r.value as DocumentReview;
      } else {
        failures.push(`${doc}: ${r?.error || "unknown"}`);
      }
    }

    // A failed review is not fatal to the pipeline — the user can still read,
    // edit, and approve the documents; the failure is surfaced on the gate.
    fresh.phase = "GATE2_PENDING";
    pushPhaseHistory(fresh, "GATE2_PENDING");
    fresh.lastTransitionAt = new Date().toISOString();
    fresh.activeGate = {
      gateId: `gate-${crypto.randomUUID()}`,
      kind: "DESIGN_REVIEW",
      exhibits: [
        fresh.designDocs?.architecture?.markdown ?? "",
        fresh.designDocs?.database?.markdown ?? "",
        fresh.designDocs?.implementation?.markdown ?? "",
      ],
      context: {
        ...(failures.length ? { reviewFailures: failures } : {}),
        reviewer: fresh.reviews?.architecture?.reviewer
          ?? fresh.reviews?.database?.reviewer
          ?? fresh.reviews?.implementation?.reviewer
          ?? "unavailable",
      },
    };
    await savePipeline(fresh);
    console.log(
      `[CEO-Review] Done for ${pipelineId}` +
      (failures.length ? ` (failures: ${failures.join("; ")})` : "")
    );
  } catch (err: any) {
    const s = await getPipeline(pipelineId);
    if (!s) return;
    s.phase = "FAILED";
    pushPhaseHistory(s, "FAILED");
    s.error = `CEO review phase failed: ${err.message || String(err)}`;
    s.lastTransitionAt = new Date().toISOString();
    await savePipeline(s);
  }
}
