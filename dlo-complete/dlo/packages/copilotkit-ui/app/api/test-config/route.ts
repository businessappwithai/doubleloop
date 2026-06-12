import { NextResponse } from "next/server";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { checkAndInstallBinaries } from "@dlo/adapters-pi";

const execAsync = promisify(exec);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const config = body.config;

    // Run the check and installation logic
    await checkAndInstallBinaries(process.cwd());

    const geminiKey = config?.providers?.research?.apiKey || process.env.GEMINI_API_KEY;
    const anthropicKey = config?.providers?.planner?.apiKey || config?.providers?.supervisor?.apiKey || process.env.ANTHROPIC_API_KEY;
    const deepseekKey = config?.providers?.executor?.apiKey || process.env.DEEPSEEK_API_KEY;
    const piKey = config?.providers?.harness?.apiKey || process.env.PI_API_KEY;

    const results = {
      binaries: {
        claude: { status: "checking", message: "" },
        codewhale: { status: "checking", message: "" },
        ocr: { status: "checking", message: "" }
      },
      keys: {
        gemini: { status: "checking", message: "" },
        anthropic: { status: "checking", message: "" },
        deepseek: { status: "checking", message: "" },
        pi: { status: "checking", message: "" }
      }
    };

    // 1. Verify Claude Code binary is available and runnable
    try {
      const localBin = join(process.cwd(), ".dlo/bin");
      const pathWithLocal = `${localBin}:${process.env.PATH}`;
      // Runs claude with --help. Our shim prints { kind: "PASS", critique: "" } which exits with 0.
      await execAsync("claude --help", { env: { ...process.env, PATH: pathWithLocal } });
      results.binaries.claude = { status: "passed", message: "Claude Code CLI is available and responding." };
    } catch (err: any) {
      results.binaries.claude = { status: "failed", message: `Claude Code CLI is not available: ${err.message}` };
    }

    // 2. Verify CodeWhale binary is available and runnable
    try {
      const localBin = join(process.cwd(), ".dlo/bin");
      const pathWithLocal = `${localBin}:${process.env.PATH}`;
      await execAsync("codewhale --help", { env: { ...process.env, PATH: pathWithLocal } });
      results.binaries.codewhale = { status: "passed", message: "CodeWhale Swarm CLI is available and responding." };
    } catch (err: any) {
      results.binaries.codewhale = { status: "failed", message: `CodeWhale Swarm CLI is not available: ${err.message}` };
    }

    // 3. Verify open-code-review (ocr) binary is available and runnable
    try {
      const localBin = join(process.cwd(), ".dlo/bin");
      const pathWithLocal = `${localBin}:${process.env.PATH}`;
      await execAsync("ocr --help", { env: { ...process.env, PATH: pathWithLocal } });
      results.binaries.ocr = { status: "passed", message: "open-code-review CLI is available and responding." };
    } catch (err: any) {
      results.binaries.ocr = { status: "failed", message: `open-code-review CLI is not available: ${err.message}` };
    }

    // 3. Verify keys presence
    if (geminiKey) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
        const data = await response.json();
        if (response.ok && data.models) {
          const names = data.models.map((m: any) => m.name.replace("models/", ""));
          console.log("=== Available Gemini Models for Key ===", names);
          results.keys.gemini = { 
            status: "passed", 
            message: `Gemini API Key is valid. Available models: ${names.slice(0, 5).join(", ")}` 
          };
        } else {
          results.keys.gemini = { 
            status: "failed", 
            message: `Gemini API validation failed: ${data.error?.message || "Invalid API response"}` 
          };
        }
      } catch (err: any) {
        results.keys.gemini = { 
          status: "failed", 
          message: `Gemini API validation error: ${err.message}` 
        };
      }
    } else {
      results.keys.gemini = { status: "failed", message: "Google Gemini API Key is missing." };
    }

    const plannerModel = config?.providers?.planner?.model || "";
    const supervisorModel = config?.providers?.supervisor?.model || "";
    const isPlannerGemini = plannerModel.toLowerCase().startsWith("gemini") || plannerModel.toLowerCase().startsWith("google");
    const isSupervisorGemini = supervisorModel.toLowerCase().startsWith("gemini") || supervisorModel.toLowerCase().startsWith("google");

    if (anthropicKey) {
      results.keys.anthropic = { status: "passed", message: "Anthropic/Claude API Key is configured." };
    } else if ((isPlannerGemini || isSupervisorGemini) && geminiKey) {
      results.keys.anthropic = { 
        status: "passed", 
        message: `Bypassed Claude key. Using Gemini Key with model: ${[
          isPlannerGemini ? plannerModel : null,
          isSupervisorGemini ? supervisorModel : null
        ].filter(Boolean).join(", ")}` 
      };
    } else {
      results.keys.anthropic = { status: "failed", message: "Anthropic/Claude API Key is missing. Select a Gemini model for Planner & Supervisor if you want to use Gemini." };
    }

    results.keys.deepseek = deepseekKey
      ? { status: "passed", message: "DeepSeek API Key is configured." }
      : { status: "failed", message: "DeepSeek API Key is missing." };

    results.keys.pi = piKey
      ? { status: "passed", message: "Pi Harness API Key is configured." }
      : { status: "passed", message: "Pi Harness Key is optional (using local shims)." };

    return NextResponse.json({ success: true, results });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
