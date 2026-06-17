/**
 * packages/copilotkit-ui/src/lib/agents.ts
 * CopilotKit agent definitions for DLO pipeline operations.
 */

import { useDloStore } from "./store";

/**
 * Initialize a new pipeline via CopilotKit agent.
 * The agent gathers project name, objectives, and workspace directory,
 * then calls dlo init and starts polling.
 */
export function useInitPipelineAgent() {
  const store = useDloStore();

  return {
    name: "initialize_pipeline",
    description: "Initialize a new DLO pipeline for autonomous development",

    instructions: `You are the pipeline initialization agent. Your job is to:
1. Ask the user for the project name (e.g., "Authentication Service", "E-commerce API")
2. Ask for the project objectives as markdown (what should this app do?)
3. Ask for the workspace directory path (where to generate the code)
4. Summarize the configuration and confirm with the user
5. Once confirmed, call the initialize_pipeline tool to start the pipeline

Be conversational and helpful. Explain what each step means.`,

    tools: [
      {
        name: "initialize_pipeline",
        description: "Initialize a new DLO pipeline with the given configuration",
        inputSchema: {
          type: "object",
          properties: {
            projectName: {
              type: "string",
              description: "Name of the project (e.g., 'Authentication Service')",
            },
            objectivesMarkdown: {
              type: "string",
              description: "Project objectives and requirements as markdown",
            },
            workspaceDir: {
              type: "string",
              description: "Workspace directory path where code will be generated",
            },
          },
          required: ["projectName", "objectivesMarkdown", "workspaceDir"],
        },
        execute: async (input: any) => {
          try {
            let config: any = {};
            if (typeof window !== "undefined") {
              try {
                const stored = localStorage.getItem("dlo-config");
                if (stored) config = JSON.parse(stored);
              } catch (err) {
                console.error("Failed to parse stored config:", err);
              }
            }
            await store.initPipeline({
              projectName: input.projectName,
              objectivesMarkdown: input.objectivesMarkdown,
              workspaceDir: input.workspaceDir,
              config,
            });

            return {
              success: true,
              message: `Pipeline initialized! Pipeline ID: ${store.activePipelineId}. Monitoring status...`,
            };
          } catch (e) {
            return {
              success: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        },
      },
    ],
  };
}

/**
 * Monitor the pipeline's execution and report status.
 */
export function useMonitorPipelineAgent() {
  const store = useDloStore();

  return {
    name: "monitor_pipeline",
    description: "Monitor the current pipeline's execution status and progress",

    instructions: `You are the pipeline monitoring agent. Your job is to:
1. Check the current pipeline status (phase, modules completed, budget spent)
2. Report to the user in a clear, readable format
3. If there's an active gate (HITL decision point), notify the user
4. If the pipeline has failed or completed, provide a summary

Always be friendly and provide actionable information. Use the get_pipeline_status tool to fetch current data.`,

    tools: [
      {
        name: "get_pipeline_status",
        description: "Get the current status of the active pipeline",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          const client = store.client;
          const pipelineId = store.activePipelineId;

          if (!client || !pipelineId) {
            return { error: "No active pipeline. Initialize one first." };
          }

          try {
            const status = await client.getPipelineStatus(pipelineId);
            return {
              phase: status.phase,
              createdAt: status.createdAt,
              board: status.board,
              budget: status.budget,
              activeGate: status.activeGate,
              domainDocument: status.domainDocument ? "Available" : "Not yet generated",
              plan: status.plan ? "Available" : "Not yet planned",
            };
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        },
      },
    ],
  };
}

/**
 * Resolve HITL gates (approve, steer, reject).
 */
export function useGateResolutionAgent() {
  const store = useDloStore();

  return {
    name: "resolve_gate",
    description: "Resolve an open HITL gate (approve, steer, or reject)",

    instructions: `You are the gate resolution agent. When the pipeline has an open HITL gate, your job is to:
1. Retrieve the gate details (what is being reviewed, options)
2. Explain the options to the user in clear language
3. Ask the user which decision they want to make (APPROVE, STEER, or REJECT)
4. If STEER, ask for the steering instructions
5. Call the resolve_gate tool with the user's decision

Be conversational and help the user understand the implications of each decision.`,

    tools: [
      {
        name: "resolve_gate",
        description: "Resolve an open HITL gate with a decision",
        inputSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              enum: ["APPROVE", "STEER", "REJECT"],
              description: "The decision: APPROVE (proceed), STEER (revise), or REJECT (restart)",
            },
            instructions: {
              type: "string",
              description: "For STEER: detailed instructions for revision",
            },
            reason: {
              type: "string",
              description: "For REJECT: reason for rejection",
            },
            note: {
              type: "string",
              description: "Optional note to attach to the resolution",
            },
          },
          required: ["decision"],
        },
        execute: async (input: any) => {
          const status = store.pipelineStatus;
          if (!status?.activeGate) {
            return { error: "No active gate to resolve" };
          }

          try {
            await store.resolveGate(status.activeGate.gateId, input.decision, {
              instructions: input.instructions,
              reason: input.reason,
              note: input.note,
            });

            return {
              success: true,
              message: `Gate resolved with decision: ${input.decision}. Pipeline will continue...`,
            };
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        },
      },
    ],
  };
}

/**
 * Monitor and control the build, test, and deploy phases.
 */
export function useBuildDeployAgent() {
  const store = useDloStore();

  return {
    name: "build_test_deploy",
    description: "Build, test, and deploy the generated application — monitor progress and resolve gates",

    instructions: `You are the build, test, and deploy agent. Your job is to:
1. Monitor and report the pipeline's build, test, and deployment status
2. Explain each stage clearly:
   - BUILD_RUNNING: Compiling and bundling the application (npm run build or ./gradlew assembleDebug)
   - TESTING_RUNNING: Running the automated test suite
   - DEPLOY_RUNNING: Deploying the app (Android APK via ADB, or web app served at localhost)
3. When a TERMINAL_PERMISSION gate is open, explain exactly what commands will run and help the user decide
4. Report artifact locations (APK path, dist/ directory) and deployment URLs when available
5. If tests failed, summarize the failures and suggest next steps

Always use get_build_deploy_status first to get current state before advising the user.`,

    tools: [
      {
        name: "get_build_deploy_status",
        description: "Get current build, test, and deployment status of the active pipeline",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          const pipelineId = store.activePipelineId;
          const status = store.pipelineStatus;

          if (!pipelineId || !status) {
            return { error: "No active pipeline. Initialize one first." };
          }

          return {
            phase: status.phase,
            buildResults: (status as any).buildResults ?? null,
            testResults: status.testResults ?? null,
            deployResults: (status as any).deployResults ?? null,
            appUrl: status.appUrl ?? null,
            activeGate: status.activeGate
              ? {
                  gateId: status.activeGate.gateId,
                  kind: status.activeGate.kind,
                  description: status.activeGate.exhibits?.[0]?.slice(0, 300),
                }
              : null,
          };
        },
      },
      {
        name: "approve_build_deploy_gate",
        description: "Approve or reject the current build/test/deploy permission gate",
        inputSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              enum: ["APPROVE", "REJECT"],
              description: "APPROVE to execute the phase, REJECT to skip it and move on",
            },
          },
          required: ["decision"],
        },
        execute: async (input: any) => {
          const status = store.pipelineStatus;
          if (!status?.activeGate) {
            return { error: "No active gate to resolve" };
          }
          try {
            await store.resolveGate(status.activeGate.gateId, input.decision as "APPROVE" | "REJECT", {});
            return {
              success: true,
              message: `Gate ${input.decision === "APPROVE" ? "approved — phase running" : "rejected — skipping to next phase"}.`,
            };
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        },
      },
    ],
  };
}

/**
 * View artifacts and documentation.
 */
export function useArtifactViewerAgent() {
  const store = useDloStore();

  return {
    name: "view_artifacts",
    description: "View generated artifacts (domain document, plans, critiques)",

    instructions: `You are the artifact viewer agent. Your job is to help the user explore the artifacts generated by the pipeline:
1. Domain Document: the initial research synthesis
2. CEO Plan: business-level requirements
3. Architecture Plan: system design and data flow
4. Module critiques: feedback on implementation attempts

Ask the user which artifact they'd like to view, fetch it, and present it in a readable format.`,

    tools: [
      {
        name: "get_domain_document",
        description: "Get the domain research document",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          const status = store.pipelineStatus;
          if (!status?.domainDocument) {
            return { error: "Domain document not yet available" };
          }

          const client = store.client;
          if (!client) return { error: "Client not initialized" };

          return {
            markdown: status.domainDocument.markdown,
            citations: status.domainDocument.citations,
          };
        },
      },
      {
        name: "get_plan",
        description: "Get the strategic plan (CEO, Architecture, or Engineering)",
        inputSchema: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["ceo", "architecture", "engineering"],
              description: "Which plan to retrieve",
            },
          },
          required: ["kind"],
        },
        execute: async (input: any) => {
          const status = store.pipelineStatus;
          if (!status?.plan) {
            return { error: "Plan not yet available" };
          }

          const client = store.client;
          if (!client) return { error: "Client not initialized" };

          const key = `${input.kind}Plan` as "ceoPlan" | "architecturePlan" | "engineeringPlan";
          return {
            plan: (status.plan as any)[key],
          };
        },
      },
    ],
  };
}
