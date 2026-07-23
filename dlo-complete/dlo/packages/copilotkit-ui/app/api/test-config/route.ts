import { NextResponse } from "next/server";
import { checkAndInstallBinaries } from "@dlo/adapters-pi";
import { checkClaudeCli } from "@/lib/orchestrator";
import { checkLangflow } from "@/lib/orchestrator/langflow";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const config = body.config;

    // Real binary check (attempts real installs for missing ones; never shims).
    const binaryStatuses = await checkAndInstallBinaries(process.cwd());

    const geminiKey = config?.providers?.research?.apiKey || process.env.GEMINI_API_KEY;
    const anthropicKey = config?.providers?.planner?.apiKey || config?.providers?.supervisor?.apiKey || process.env.ANTHROPIC_API_KEY;
    const deepseekKey = config?.providers?.executor?.apiKey || process.env.DEEPSEEK_API_KEY;
    const piKey = config?.providers?.harness?.apiKey || process.env.PI_API_KEY;
    const subscriptionMode = config?.providers?.planner?.auth === "subscription";

    const results: any = {
      binaries: {
        claude: { status: "failed", message: "claude CLI not found on PATH" },
        codewhale: { status: "failed", message: "codewhale CLI not found on PATH" },
        ocr: { status: "failed", message: "ocr CLI not found on PATH" },
      },
      keys: {
        gemini: { status: "checking", message: "" },
        anthropic: { status: "checking", message: "" },
        deepseek: { status: "checking", message: "" },
        pi: { status: "checking", message: "" },
      },
      langflow: { status: "failed", message: "No Langflow URL configured (optional — built-in designer canvas is used instead)." },
    };

    for (const bin of binaryStatuses) {
      if (bin.name in results.binaries) {
        results.binaries[bin.name] = {
          status: bin.available ? "passed" : "failed",
          message: bin.detail,
        };
      }
    }

    // Claude CLI detail (version + auth mode guidance)
    const claudeStatus = await checkClaudeCli();
    if (claudeStatus.available) {
      results.binaries.claude = {
        status: "passed",
        message: subscriptionMode
          ? `Claude Code CLI available (${claudeStatus.detail}). Subscription mode: the CLI must be logged in on this host (claude setup-token).`
          : `Claude Code CLI available (${claudeStatus.detail}).`,
      };
    }

    // Gemini key validation
    if (geminiKey) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
        const data = await response.json();
        if (response.ok && data.models) {
          const names = data.models.map((m: any) => m.name.replace("models/", ""));
          results.keys.gemini = {
            status: "passed",
            message: `Gemini API Key is valid. Available models: ${names.slice(0, 5).join(", ")}`,
          };
        } else {
          results.keys.gemini = {
            status: "failed",
            message: `Gemini API validation failed: ${data.error?.message || "Invalid API response"}`,
          };
        }
      } catch (err: any) {
        results.keys.gemini = { status: "failed", message: `Gemini API validation error: ${err.message}` };
      }
    } else {
      results.keys.gemini = {
        status: "failed",
        message: "Google Gemini API Key is missing — the manual research textarea will be used instead.",
      };
    }

    const plannerModel = config?.providers?.planner?.model || "";
    const supervisorModel = config?.providers?.supervisor?.model || "";
    const isPlannerGemini = plannerModel.toLowerCase().startsWith("gemini") || plannerModel.toLowerCase().startsWith("google");
    const isSupervisorGemini = supervisorModel.toLowerCase().startsWith("gemini") || supervisorModel.toLowerCase().startsWith("google");

    if (subscriptionMode) {
      results.keys.anthropic = claudeStatus.available
        ? { status: "passed", message: "Subscription mode: Claude Code uses the CLI's coding-plan login (no API key billed)." }
        : { status: "failed", message: "Subscription mode selected but the claude CLI is not available on this host." };
    } else if (anthropicKey) {
      results.keys.anthropic = { status: "passed", message: "Anthropic/Claude API Key is configured." };
    } else if ((isPlannerGemini || isSupervisorGemini) && geminiKey) {
      results.keys.anthropic = {
        status: "passed",
        message: `Bypassed Claude key. Using Gemini Key with model: ${[
          isPlannerGemini ? plannerModel : null,
          isSupervisorGemini ? supervisorModel : null,
        ].filter(Boolean).join(", ")}`,
      };
    } else {
      results.keys.anthropic = {
        status: "failed",
        message: "Anthropic/Claude API Key is missing. Switch Claude Code Auth to 'subscription' if the CLI is logged in, or provide a key.",
      };
    }

    results.keys.deepseek = deepseekKey
      ? { status: "passed", message: "DeepSeek API Key is configured (CodeWhale executor)." }
      : { status: "failed", message: "DeepSeek API Key is missing (only needed for the CodeWhale executor)." };

    results.keys.pi = piKey
      ? { status: "passed", message: "Pi Harness API Key is configured." }
      : { status: "passed", message: "Pi Harness key is optional — the local subagent runner is used when the pi SDK is absent (reported in artifacts)." };

    // Langflow reachability (optional)
    const langflowUrl = config?.langflow?.url || process.env.LANGFLOW_URL;
    if (langflowUrl) {
      const lf = await checkLangflow({ url: String(langflowUrl).replace(/\/$/, ""), apiKey: config?.langflow?.apiKey || process.env.LANGFLOW_API_KEY });
      results.langflow = { status: lf.reachable ? "passed" : "failed", message: lf.detail };
    }

    return NextResponse.json({ success: true, results });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
