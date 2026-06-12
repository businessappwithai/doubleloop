import { CopilotRuntime, GoogleGenerativeAIAdapter } from "@copilotkit/backend";
import { GoogleGenerativeAI } from "@google/generative-ai";

interface CachedModels {
  models: string[];
  timestamp: number;
}
const modelsCache = new Map<string, CachedModels>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function POST(req: Request) {
  try {
    const geminiKeyHeader = req.headers.get("x-gemini-key");
    const apiKey = geminiKeyHeader || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
    
    if (!apiKey) {
      throw new Error("Gemini API Key is missing. Please configure it in your environment variables or in the settings modal (Config Keys & Limits).");
    }

    const copilotModelHeader = req.headers.get("x-copilot-model");
    const modelName = copilotModelHeader || process.env.GEMINI_COPILOT_MODEL || "gemini-1.5-pro";

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Dynamically discover which model from the key's allowed models list to use
    let finalModelName = modelName;
    try {
      let availableModels: string[] = [];
      const now = Date.now();
      const cached = modelsCache.get(apiKey);
      
      if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
        availableModels = cached.models;
      } else {
        const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (listResponse.ok) {
          const data = await listResponse.json();
          if (data.models && data.models.length > 0) {
            availableModels = data.models.map((m: any) => m.name.replace("models/", ""));
            modelsCache.set(apiKey, { models: availableModels, timestamp: now });
          }
        }
      }

      if (availableModels.length > 0) {
        const hasRequested = availableModels.some((name: string) => 
          name.toLowerCase() === finalModelName.toLowerCase() || 
          `models/${name}`.toLowerCase() === finalModelName.toLowerCase()
        );
        
        if (!hasRequested) {
          // Check if there is a newer pro or flash model available (e.g. gemini-2.5-flash, gemini-2.0-flash, gemini-2.5-pro)
          // Prefer flash models for general chat as they have significantly higher/available free tier quotas
          const preferredModels = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-flash-latest", "gemini-pro-latest"];
          const foundPreferred = preferredModels.find(pref => 
            availableModels.some((av: string) => av.toLowerCase() === pref.toLowerCase())
          );
          
          if (foundPreferred) {
            finalModelName = foundPreferred;
          } else {
            // Otherwise find any model containing 'flash'
            const flashModel = availableModels.find(av => av.toLowerCase().includes("flash"));
            if (flashModel) {
              finalModelName = flashModel;
            } else {
              finalModelName = availableModels[0] || finalModelName;
            }
          }
          console.log(`Model "${modelName}" not found. Auto-discovered and selected: "${finalModelName}"`);
        }
      }
    } catch (e) {
      console.warn("Failed to discover models list, using requested model:", e);
    }

    const model = genAI.getGenerativeModel({ model: finalModelName });

    const copilotRuntime = new CopilotRuntime();
    return copilotRuntime.response(req, new GoogleGenerativeAIAdapter({ model }));
  } catch (error: any) {
    console.error("CopilotKit route error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "content-type": "application/json" } });
  }
}


