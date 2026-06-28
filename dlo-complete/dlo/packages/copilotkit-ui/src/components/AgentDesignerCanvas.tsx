"use client";

import { useCallback, useState, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Connection,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ModuleNode, Vendor, DEFAULT_MODELS } from "./ModuleNode";
import type { ModuleNodeData } from "./ModuleNode";

// Re-export for convenience
export { DEFAULT_MODELS };

export interface EngineeringModule {
  moduleId: string;
  title: string;
  stackTarget: string;
  estimatedComplexity: string;
  touches: string[];
  prompt: string;
  dependsOn: string[];
}

type AgentConfig = Record<string, { vendor: Vendor; model: string }>;

const NODE_TYPES = { moduleNode: ModuleNode };

/** Assign layer numbers via BFS from roots (topo sort) */
function computeLayers(modules: EngineeringModule[]): Map<string, number> {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // id → who depends on it

  for (const m of modules) {
    if (!inDegree.has(m.moduleId)) inDegree.set(m.moduleId, 0);
    if (!dependents.has(m.moduleId)) dependents.set(m.moduleId, []);
    for (const dep of m.dependsOn) {
      inDegree.set(m.moduleId, (inDegree.get(m.moduleId) ?? 0) + 1);
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(m.moduleId);
    }
  }

  const layers = new Map<string, number>();
  const queue: string[] = [];

  for (const [id, deg] of inDegree) {
    if (deg === 0) { layers.set(id, 0); queue.push(id); }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const layer = layers.get(id) ?? 0;
    for (const child of (dependents.get(id) ?? [])) {
      const next = Math.max(layers.get(child) ?? 0, layer + 1);
      layers.set(child, next);
      inDegree.set(child, (inDegree.get(child) ?? 1) - 1);
      if ((inDegree.get(child) ?? 0) <= 0) queue.push(child);
    }
  }

  // Assign remaining (cycle members or missed) to layer 0
  for (const m of modules) {
    if (!layers.has(m.moduleId)) layers.set(m.moduleId, 0);
  }

  return layers;
}

function buildInitialGraph(
  modules: EngineeringModule[],
  savedConfig: Record<string, { vendor: Vendor; model: string }>,
  onVendorChange: (id: string, v: Vendor) => void,
  onModelChange: (id: string, m: string) => void,
) {
  const layers = computeLayers(modules);

  // Group modules by layer
  const byLayer = new Map<number, string[]>();
  for (const [id, layer] of layers) {
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(id);
  }

  const NODE_W = 288;
  const NODE_H = 200; // approx height
  const X_GAP = 60;
  const Y_GAP = 80;

  const nodes = modules.map(m => {
    const layer = layers.get(m.moduleId) ?? 0;
    const layerIds = byLayer.get(layer) ?? [m.moduleId];
    const posInLayer = layerIds.indexOf(m.moduleId);
    const totalWidth = layerIds.length * (NODE_W + X_GAP) - X_GAP;
    const startX = -totalWidth / 2;

    const saved = savedConfig[m.moduleId];
    const vendor: Vendor = saved?.vendor ?? "codewhale";
    const model: string = saved?.model ?? DEFAULT_MODELS[vendor];

    return {
      id: m.moduleId,
      type: "moduleNode",
      position: {
        x: startX + posInLayer * (NODE_W + X_GAP),
        y: layer * (NODE_H + Y_GAP),
      },
      data: {
        ...m,
        vendor,
        model,
        onVendorChange,
        onModelChange,
      } as unknown as Record<string, unknown>,
    };
  });

  const edges = modules.flatMap(m =>
    m.dependsOn.map(dep => ({
      id: `${dep}->${m.moduleId}`,
      source: dep,
      target: m.moduleId,
      animated: true,
      style: { stroke: "#3b82f6", strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#3b82f6" },
    }))
  );

  return { nodes, edges };
}

interface AgentDesignerCanvasProps {
  modules: EngineeringModule[];
  savedConfig?: Record<string, { vendor: Vendor; model: string }>;
  onConfigChange?: (config: Record<string, { vendor: Vendor; model: string }>) => void;
}

export function AgentDesignerCanvas({ modules, savedConfig = {}, onConfigChange }: AgentDesignerCanvasProps) {
  // Per-module vendor/model state (separate from node positions)
  const [agentConfig, setAgentConfig] = useState<Record<string, { vendor: Vendor; model: string }>>(() => {
    const init: Record<string, { vendor: Vendor; model: string }> = {};
    for (const m of modules) {
      init[m.moduleId] = savedConfig[m.moduleId] ?? { vendor: "codewhale", model: DEFAULT_MODELS["codewhale"] };
    }
    return init;
  });

  const handleVendorChange = useCallback((id: string, vendor: Vendor) => {
    setAgentConfig(prev => {
      const next: AgentConfig = { ...prev, [id]: { vendor, model: prev[id]?.model ?? DEFAULT_MODELS[vendor] } };
      onConfigChange?.(next);
      return next;
    });
  }, [onConfigChange]);

  const handleModelChange = useCallback((id: string, model: string) => {
    setAgentConfig(prev => {
      const existing = prev[id] ?? { vendor: "codewhale" as Vendor, model: DEFAULT_MODELS["codewhale"] };
      const next: AgentConfig = { ...prev, [id]: { ...existing, model } };
      onConfigChange?.(next);
      return next;
    });
  }, [onConfigChange]);

  const initialGraph = useMemo(
    () => buildInitialGraph(modules, savedConfig, handleVendorChange, handleModelChange),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modules]
  );

  const [nodes, , onNodesChange] = useNodesState(initialGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialGraph.edges);

  // Keep node data in sync with agentConfig (vendor/model changes)
  const syncedNodes = useMemo(() =>
    nodes.map(n => ({
      ...n,
      data: {
        ...(n.data as Record<string, unknown>),
        vendor: agentConfig[n.id]?.vendor ?? (n.data as unknown as ModuleNodeData).vendor,
        model: agentConfig[n.id]?.model ?? (n.data as unknown as ModuleNodeData).model,
        onVendorChange: handleVendorChange,
        onModelChange: handleModelChange,
      } as Record<string, unknown>,
    })),
    [nodes, agentConfig, handleVendorChange, handleModelChange]
  );

  const onConnect = useCallback(
    (params: Connection) => setEdges(eds => addEdge(params, eds)),
    [setEdges]
  );

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={syncedNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        className="bg-slate-950"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="#334155"
        />
        <Controls className="!bg-slate-800 !border-slate-700 [&_button]:!bg-slate-800 [&_button]:!border-slate-700 [&_button]:!text-slate-300 [&_button:hover]:!bg-slate-700" />
        <MiniMap
          nodeColor="#1e293b"
          maskColor="rgba(15,23,42,0.7)"
          className="!bg-slate-900 !border-slate-700"
        />
      </ReactFlow>
    </div>
  );
}
