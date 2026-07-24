import { getLogs, subscribeToLogs } from "@/lib/orchestrator/logStore";

/**
 * GET /api/pipelines/[pipelineId]/logs
 *
 * Server-Sent Events stream of live subprocess output.
 * Sends all buffered lines first, then streams new lines as they arrive.
 * Each event: `data: {"line":"...","ts":"ISO"}\n\n`
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  const { pipelineId } = await params;

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      const send = (line: string) => {
        const payload = JSON.stringify({ line, ts: new Date().toISOString() });
        controller.enqueue(enc.encode(`data: ${payload}\n\n`));
      };

      // Replay buffered lines.
      for (const line of getLogs(pipelineId)) {
        send(line);
      }

      // Subscribe to new lines.
      const unsub = subscribeToLogs(pipelineId, send);

      request.signal.addEventListener("abort", () => {
        unsub();
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
