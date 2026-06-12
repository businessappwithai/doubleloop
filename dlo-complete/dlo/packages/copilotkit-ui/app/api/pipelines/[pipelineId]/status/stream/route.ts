import { getPipeline } from "@/lib/pipeline-helper";

export async function GET(
  request: Request,
  { params }: { params: { pipelineId: string } }
) {
  const { pipelineId } = params;

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
