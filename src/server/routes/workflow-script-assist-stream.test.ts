// @vitest-environment node
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerWorkflowRoutes } from "./workflows";
import { DomainError } from "../core/errors";
import type { WorkflowScriptAssistProgress } from "../../shared/workflow-contracts";

/** 使用真实 HTTP 流确认生成尚未结束时客户端已收到增量，并验证断连取消。 */
describe("脚本辅助 SSE", () => {
  it("认证保护、增量、完成和流内错误均遵守协议", async () => {
    let authenticated = false;
    let fail = false;
    const assistScript = vi.fn(async (_input: unknown, _signal: AbortSignal, emit: (event: WorkflowScriptAssistProgress) => Promise<void>) => {
      await emit({ type: "started" });
      await emit({ type: "thinking_delta", delta: "检查类型" });
      await emit({ type: "text_delta", delta: "return {};" });
      if (fail) throw new DomainError("REQUEST_FAILED", "测试模型输出被截断");
      await emit({ type: "validating" });
      return { script: "return {};" };
    });
    const app = Fastify();
    registerWorkflowRoutes(app, { authService: { isAuthenticated: async () => authenticated } as never, executor: { assistScript } as never, service: {} as never, files: {} as never });
    const options = { method: "POST" as const, url: "/api/workflows/script-assist", headers: { accept: "text/event-stream" }, payload: {} };
    try {
      expect((await app.inject(options)).statusCode).toBe(401);
      expect(assistScript).not.toHaveBeenCalled();
      authenticated = true;
      const result = await app.inject(options);
      expect(result.headers["content-type"]).toContain("text/event-stream");
      expect(result.headers["cache-control"]).toContain("no-store");
      const frames = result.body.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("data: ")[1]));
      expect(frames.map((event) => event.type)).toEqual(["started", "thinking_delta", "text_delta", "validating", "completed"]);
      fail = true;
      const failed = await app.inject(options);
      const terminal = JSON.parse(failed.body.trim().split("data: ").at(-1)!);
      expect(terminal).toMatchObject({ type: "error", error: { code: "REQUEST_FAILED", message: "测试模型输出被截断", requestId: failed.headers["x-request-id"] } });
      expect(failed.body).not.toContain('"type":"completed"');
    } finally { await app.close(); }
  });
  it("客户端取消立即中止仍在等待的模型调用", async () => {
    let modelSignal: AbortSignal | undefined;
    const app = Fastify();
    registerWorkflowRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      executor: { assistScript: async (_input: unknown, signal: AbortSignal, emit: (event: WorkflowScriptAssistProgress) => Promise<void>) => {
        modelSignal = signal;
        await emit({ type: "thinking_delta", delta: "还在思考" });
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        signal.throwIfAborted();
      } } as never,
      service: {} as never, files: {} as never,
    });
    const controller = new AbortController();
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const result = await fetch(`${address}/api/workflows/script-assist`, { method: "POST", headers: { accept: "text/event-stream", "content-type": "application/json" }, body: "{}", signal: controller.signal });
      const reader = result.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("还在思考");
      expect(modelSignal?.aborted).toBe(false);
      controller.abort();
      await vi.waitFor(() => expect(modelSignal?.aborted).toBe(true));
      reader.releaseLock();
    } finally { controller.abort(); await app.close(); }
  });
});
