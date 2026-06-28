"use client";

import { memo, useState, useCallback } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { ChevronDown, ChevronRight } from "lucide-react";

export type Vendor = "codewhale" | "claude-code" | "pi";

export const DEFAULT_MODELS: Record<Vendor, string> = {
  "codewhale": "deepseek-coder",
  "claude-code": "claude-haiku-4-5-20251001",
  "pi": "pi-default-model",
};

const STACK_COLORS: Record<string, string> = {
  "rust-axum": "bg-orange-900/60 text-orange-300 border-orange-700/60",
  "postgresql": "bg-blue-900/60 text-blue-300 border-blue-700/60",
  "tanstack-start": "bg-purple-900/60 text-purple-300 border-purple-700/60",
  "cross-cutting": "bg-slate-700/60 text-slate-300 border-slate-600/60",
};

const COMPLEXITY_COLORS: Record<string, string> = {
  "trivial": "bg-green-900/60 text-green-300",
  "standard": "bg-yellow-900/60 text-yellow-300",
  "complex": "bg-red-900/60 text-red-300",
};

export interface ModuleNodeData {
  moduleId: string;
  title: string;
  stackTarget: string;
  estimatedComplexity: string;
  touches: string[];
  prompt: string;
  vendor: Vendor;
  model: string;
  onVendorChange: (moduleId: string, vendor: Vendor) => void;
  onModelChange: (moduleId: string, model: string) => void;
}

function ModuleNodeInner({ data }: NodeProps) {
  const d = data as unknown as ModuleNodeData;
  const [showTouches, setShowTouches] = useState(false);

  const handleVendorChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value as Vendor;
    d.onVendorChange(d.moduleId, v);
    // Auto-fill default model only if model is currently a default of the old vendor
    const isDefault = Object.values(DEFAULT_MODELS).includes(d.model);
    if (isDefault) {
      d.onModelChange(d.moduleId, DEFAULT_MODELS[v]);
    }
  }, [d]);

  const handleModelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    d.onModelChange(d.moduleId, e.target.value);
  }, [d]);

  return (
    <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-xl w-72 text-xs select-none">
      {/* Top handle — dependencies come IN here */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-slate-500 !border-slate-400 !w-2.5 !h-2.5"
      />

      {/* Header */}
      <div className="bg-slate-900/80 px-3 py-2 rounded-t-lg border-b border-slate-700 flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-white text-sm leading-tight truncate" title={d.title}>
            {d.title}
          </p>
          <p className="text-slate-500 font-mono mt-0.5 truncate">{d.moduleId}</p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${STACK_COLORS[d.stackTarget] || STACK_COLORS["cross-cutting"]}`}>
            {d.stackTarget}
          </span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${COMPLEXITY_COLORS[d.estimatedComplexity] || COMPLEXITY_COLORS["standard"]}`}>
            {d.estimatedComplexity}
          </span>
        </div>
      </div>

      {/* Touches toggle */}
      <div className="px-3 py-1.5 border-b border-slate-700/60">
        <button
          onClick={() => setShowTouches(v => !v)}
          className="flex items-center gap-1 text-slate-400 hover:text-slate-200 transition w-full"
        >
          {showTouches ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
          <span className="text-[10px] uppercase tracking-wide">
            {d.touches.length} file{d.touches.length !== 1 ? "s" : ""}
          </span>
        </button>
        {showTouches && (
          <ul className="mt-1 space-y-0.5 max-h-20 overflow-y-auto">
            {d.touches.map(t => (
              <li key={t} className="font-mono text-[10px] text-slate-400 truncate pl-4" title={t}>{t}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Agent config */}
      <div className="px-3 py-2 space-y-2">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wide text-slate-500">Subagent</label>
          <select
            value={d.vendor}
            onChange={handleVendorChange}
            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200 focus:outline-none focus:border-blue-500 transition text-xs"
          >
            <option value="codewhale">CodeWhale (DeepSeek)</option>
            <option value="claude-code">Claude Code (Anthropic)</option>
            <option value="pi">Pi Harness (pi.dev)</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wide text-slate-500">Model</label>
          <input
            type="text"
            value={d.model}
            onChange={handleModelChange}
            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition text-xs font-mono"
          />
        </div>
      </div>

      {/* Bottom handle — this module is a dependency for others */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-blue-500 !border-blue-400 !w-2.5 !h-2.5"
      />
    </div>
  );
}

export const ModuleNode = memo(ModuleNodeInner);
