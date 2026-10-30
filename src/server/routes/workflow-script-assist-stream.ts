import type { FastifyReply, FastifyRequest } from "fastify";
import type { WorkflowScriptAssistRequest } from "../../shared/workflow-contracts";
import { DomainError, toSafePublicMessage } from "../core/errors";
import { SseConnection } from "../http/sse-connection";
import type { WorkflowNodeExecutor } from "../workflows/workflow-executor";

/** 将单次生成转为有终态、心跳和断连取消的 SSE，不重试模型请求。 */
export async function streamWorkflowScriptAssist(
  request: FastifyRequest<{ Body: WorkflowScriptAssistRequest }>,
  reply: FastifyReply,
  executor: WorkflowNodeExecutor,
  controller: AbortController,
): Promise<void> {
  reply.hijack();
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, no-transform",
    "X-Accel-Buffering": "no",
    "X-Request-Id": request.id,
  });
  reply.raw.flushHeaders();
  const connection = new SseConnection(reply.raw);
  // 背压终止和浏览器断连必须释放模型连接及并发名额。
  void connection.terminated.then(() => controller.abort());
  const disconnect = () => connection.close();
  reply.raw.once("close", disconnect);
  const transportError = (error: unknown) => {
    request.log.error({ err: error }, "脚本辅助流式响应写入失败");
    connection.terminate();
  };
  const heartbeat = setInterval(() => {
    void connection.heartbeat().catch(transportError);
  }, 15_000);
  heartbeat.unref();
  try {
    const result = await executor.assistScript(request.body, controller.signal, async (event) => {
      controller.signal.throwIfAborted();
      await connection.send(event);
    });
    controller.signal.throwIfAborted();
    await connection.send({ type: "completed", script: result.script });
  } catch (error) {
    if (!controller.signal.aborted) {
      const failure = error instanceof DomainError ? error : new DomainError(
        "REQUEST_FAILED",
        `脚本辅助生成失败：${toSafePublicMessage(error, "生成服务没有返回有效结果")}`,
      );
      await connection.send({ type: "error", ...failure.toDocument(request.id) }).catch(transportError);
    }
  } finally {
    clearInterval(heartbeat);
    reply.raw.off("close", disconnect);
    connection.close();
  }
}
