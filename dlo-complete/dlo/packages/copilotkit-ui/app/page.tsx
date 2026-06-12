/**
 * packages/copilotkit-ui/app/page.tsx
 */

import Link from "next/link";
import { ArrowRight, Zap, Brain, Shield } from "lucide-react";

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-slate-900/80 backdrop-blur border-b border-slate-700">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-6 h-6 text-blue-400" />
            <span className="font-bold text-white">DLO</span>
          </div>
          <Link
            href="/chat"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition"
          >
            Open Controller <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      {/* Hero */}
      <div className="max-w-7xl mx-auto px-4 py-20">
        <div className="text-center mb-20">
          <h1 className="text-5xl md:text-6xl font-bold text-white mb-6">
            Autonomous Development <span className="text-blue-400">At Scale</span>
          </h1>
          <p className="text-xl text-slate-300 mb-8 max-w-3xl mx-auto">
            DLO orchestrates a double-loop pipeline that autonomously generates production-grade software
            with human oversight at critical decision gates.
          </p>
          <Link
            href="/chat"
            className="inline-flex items-center gap-2 px-8 py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition text-lg"
          >
            Start Building <ArrowRight className="w-5 h-5" />
          </Link>
        </div>

        {/* Features */}
        <div className="grid md:grid-cols-3 gap-6 mb-20">
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-8">
            <Brain className="w-10 h-10 text-blue-400 mb-4" />
            <h3 className="text-lg font-semibold text-white mb-2">Multi-Agent Orchestration</h3>
            <p className="text-slate-400">
              Gemini Deep Research synthesizes domain knowledge. Claude Code plans architecture. CodeWhale
              executes. All coordinated through a resilient, event-sourced kernel.
            </p>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-lg p-8">
            <Shield className="w-10 h-10 text-green-400 mb-4" />
            <h3 className="text-lg font-semibold text-white mb-2">Double-Loop Verification</h3>
            <p className="text-slate-400">
              CodeWhale's inner loop fixes local LSP errors. Claude Code's outer loop reviews against
              deterministic exit clauses and architectural rules — catch logic drift before it compounds.
            </p>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-lg p-8">
            <Zap className="w-10 h-10 text-amber-400 mb-4" />
            <h3 className="text-lg font-semibold text-white mb-2">Human-in-the-Loop at Gates</h3>
            <p className="text-slate-400">
              Five critical decision points (research synthesis, plan approval, module escalations) go to
              humans. Approve, steer, or reject — the journal captures every decision immutably.
            </p>
          </div>
        </div>

        {/* Pipeline phases */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-8 mb-20">
          <h2 className="text-2xl font-bold text-white mb-6">Five-Phase Pipeline</h2>
          <div className="grid md:grid-cols-5 gap-4">
            {[
              {
                num: "I",
                title: "Research",
                desc: "Gemini Deep Research acquires domain knowledge via background interactions",
              },
              {
                num: "II",
                title: "Planning",
                desc: "Claude Code produces CEO, Architectural, and Engineering plans",
              },
              {
                num: "III/IV",
                title: "Execution",
                desc: "CodeWhale (DeepSeek V4) swarm executes modules; Claude Code verifies",
              },
              {
                num: "V",
                title: "Finalization",
                desc: "Linter, tester, builder subagents polish the codebase",
              },
              {
                num: "Report",
                title: "Summary",
                desc: "Cost breakdown, commit list, and execution metrics",
              },
            ].map((phase) => (
              <div key={phase.num} className="text-center">
                <div className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center mx-auto mb-3">
                  <span className="text-white font-bold text-lg">{phase.num}</span>
                </div>
                <h3 className="font-semibold text-white mb-1">{phase.title}</h3>
                <p className="text-sm text-slate-400">{phase.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="text-center bg-gradient-to-r from-blue-900 to-slate-900 border border-blue-700 rounded-lg p-12">
          <h2 className="text-3xl font-bold text-white mb-4">Ready to orchestrate?</h2>
          <p className="text-slate-300 mb-6 max-w-2xl mx-auto">
            The DLO controller is a CopilotKit-powered chat interface. Initialize a pipeline, monitor progress,
            resolve HITL gates, and view generated artifacts—all through natural conversation.
          </p>
          <Link
            href="/chat"
            className="inline-flex items-center gap-2 px-8 py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition"
          >
            Open Chat Controller <ArrowRight className="w-5 h-5" />
          </Link>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-slate-700 mt-20 py-8 text-center text-slate-400">
        <p>DLO v0.1.0 · Built for autonomous, verifiable software generation</p>
      </div>
    </main>
  );
}
