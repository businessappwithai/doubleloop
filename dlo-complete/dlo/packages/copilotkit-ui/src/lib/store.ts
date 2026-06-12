/**
 * packages/copilotkit-ui/src/lib/store.ts
 * Zustand store for managing pipeline state, active gates, and polling.
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { PipelineId, GateId } from "@dlo/core";
import type { DloDaemonClient, PipelineStatus } from "./dlo-client";

interface DloStore {
  // Current state
  activePipelineId: PipelineId | null;
  pipelineStatus: PipelineStatus | null;
  isPolling: boolean;
  error: string | null;

  // Client and polling
  client: DloDaemonClient | null;
  setClient: (client: DloDaemonClient) => void;

  // Pipeline operations
  initPipeline: (req: {
    projectName: string;
    objectivesMarkdown: string;
    workspaceDir: string;
    config?: any;
  }) => Promise<void>;
  setPipelineStatus: (status: PipelineStatus) => void;
  startPolling: () => Promise<void>;
  stopPolling: () => void;

  // Gate operations
  resolveGate: (gateId: GateId, decision: "APPROVE" | "STEER" | "REJECT", opts?: any) => Promise<void>;

  // Error handling
  setError: (error: string | null) => void;

  // UI state
  showReport: boolean;
  setShowReport: (show: boolean) => void;
}

let pollInterval: NodeJS.Timeout | null = null;

export const useDloStore = create<DloStore>()(
  subscribeWithSelector((set, get) => ({
    activePipelineId: null,
    pipelineStatus: null,
    isPolling: false,
    error: null,
    client: null,
    showReport: false,

    setClient: (client: DloDaemonClient) => set({ client }),
    setShowReport: (show: boolean) => set({ showReport: show }),

    initPipeline: async (req) => {
      const client = get().client;
      if (!client) {
        throw new Error("DLO client not initialized");
      }

      try {
        set({ error: null });
        const { pipelineId } = await client.initPipeline({
          projectName: req.projectName,
          objectivesMarkdown: req.objectivesMarkdown,
          workspaceDir: req.workspaceDir,
          config: req.config || {},
        });

        set({ activePipelineId: pipelineId });
        // Start polling immediately
        const store = get();
        await store.startPolling();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ error: msg });
        throw e;
      }
    },

    setPipelineStatus: (status: PipelineStatus) => {
      set({ pipelineStatus: status });
    },

    startPolling: async () => {
      const pipelineId = get().activePipelineId;
      if (!pipelineId || get().isPolling) return;

      set({ isPolling: true });
      const client = get().client;
      if (!client) return;

      // Poll every 2 seconds
      const poll = async () => {
        try {
          const status = await client.getPipelineStatus(pipelineId);
          get().setPipelineStatus(status);

          // Stop polling if pipeline is terminal
          if (["COMPLETED", "FAILED", "ABORTED"].includes(status.phase)) {
            get().stopPolling();
          }
        } catch (e) {
          console.error("Polling error:", e);
          // Continue polling even on error
        }
      };

      // Poll immediately, then set interval
      await poll();
      pollInterval = setInterval(poll, 2000);
    },

    stopPolling: () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      set({ isPolling: false });
    },

    resolveGate: async (gateId: GateId, decision: "APPROVE" | "STEER" | "REJECT", opts?: any) => {
      const client = get().client;
      if (!client) throw new Error("DLO client not initialized");

      try {
        await client.resolveGate({
          gateId,
          decision,
          ...opts,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ error: msg });
        throw e;
      }
    },

    setError: (error: string | null) => set({ error }),
  })),
);
