/**
 * orchestrator/subagents/gemini.ts
 * Gemini text generation with the same fallback/backoff behavior the research
 * phase always had: deep-research model → gemini-2.0-flash fallback, one
 * bounded retry on 429.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

export interface GeminiCallOptions {
  apiKey: string;
  model: string;
  prompt: string;
}

export interface GeminiCallResult {
  text: string;
  usedModel: string;
}

export async function generateWithGemini(opts: GeminiCallOptions): Promise<GeminiCallResult> {
  const genAI = new GoogleGenerativeAI(opts.apiKey);
  const model = genAI.getGenerativeModel({ model: opts.model });

  try {
    const result = await model.generateContent(opts.prompt);
    return { text: result.response.text(), usedModel: opts.model };
  } catch (err: any) {
    if (err.message?.includes("Interactions API") || err.message?.includes("not supported")) {
      const fallback = "gemini-2.0-flash";
      const fallbackModel = genAI.getGenerativeModel({ model: fallback });
      const result = await fallbackModel.generateContent(opts.prompt);
      return { text: result.response.text(), usedModel: fallback };
    }
    if (err.message?.includes("429") || err.message?.includes("Too Many Requests")) {
      const delayMatch = err.message?.match(/retry[^0-9]*([0-9.]+)s/i);
      const delaySec = delayMatch ? Math.min(parseFloat(delayMatch[1]), 30) : 15;
      console.warn(`[Gemini] Rate limited (429). Retrying in ${delaySec}s...`);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
      const result = await model.generateContent(opts.prompt);
      return { text: result.response.text(), usedModel: opts.model };
    }
    throw err;
  }
}

/** Human-readable quota message for the common free-tier failure. */
export function friendlyGeminiError(raw: string): string {
  return (raw.includes("429") || raw.includes("Too Many Requests")) && raw.includes("limit: 0")
    ? "Gemini free-tier quota exhausted. Upgrade to a paid plan at https://ai.google.dev or use a different API key."
    : raw;
}
