"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Database } from "lucide-react";
import { ErdPanel } from "@/components/ErdPanel";

export default function ErdPage() {
  const [pipelineId, setPipelineId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("pipeline") || localStorage.getItem("dlo-active-pipeline");
    setPipelineId(id);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-white">
      <div className="bg-slate-900 border-b border-slate-700 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link
            href={pipelineId ? `/chat?pipeline=${pipelineId}` : "/chat"}
            className="flex items-center gap-1.5 text-slate-400 hover:text-white transition text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Chat
          </Link>
          <div className="w-px h-5 bg-slate-700" />
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Database className="w-5 h-5 text-blue-400" />
            Database &amp; ERD
          </h1>
          {pipelineId && <span className="text-xs text-slate-500 font-mono hidden md:block">{pipelineId}</span>}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {pipelineId ? (
          <ErdPanel pipelineId={pipelineId} />
        ) : (
          <div className="flex items-center justify-center h-full text-slate-400 text-sm">
            No active pipeline. Start one from the chat controller first.
          </div>
        )}
      </div>
    </div>
  );
}
