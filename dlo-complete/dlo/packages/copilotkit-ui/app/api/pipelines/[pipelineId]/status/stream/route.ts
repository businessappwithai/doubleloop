import { getPipeline } from "@/lib/pipeline-helper";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  // Next 15 hands route params in as a promise; reading them synchronously is
  // only tolerated by a deprecation shim that logs an error on every request.
  const { pipelineId } = await params;

  if (!pipelineId) {
    return new Response("Missing pipeline ID", { status: 400 });
  }

  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) {
    return new Response("Pipeline not found", { status: 404 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const sendUpdate = async () => {
        const latest = await getPipeline(pipelineId);
        if (latest) {
          controller.enqueue(
            `data: ${JSON.stringify(latest)}\n\n`
          );
        }
      };

      await sendUpdate();
      const interval = setInterval(sendUpdate, 2000);

      request.signal.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
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
