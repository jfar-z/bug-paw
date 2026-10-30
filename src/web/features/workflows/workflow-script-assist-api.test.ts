// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
const streamWorkflowScriptAssist = api.assistWorkflowScript;
import type { WorkflowScriptAssistRequest } from "../../../shared/workflow-contracts";

const input = { requirement: "测试" } as WorkflowScriptAssistRequest;
afterEach(() => vi.unstubAllGlobals());
/** 按字节拆分中文、跨块边界与心跳，验证真实客户端解析及错误传播。 */
function response(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream", "X-Request-Id": "stream-test" } });
}
describe("脚本辅助流客户端", () => {
  it("逐字节中文和 CRLF 分帧，完成前传递思考与正文", async () => {
    const progress = vi.fn();
    const fetch = vi.fn(async () => response(': heartbeat\r\n\r\ndata: {"type":"thinking_delta","delta":"思考"}\r\n\r\ndata: {"type":"text_delta","delta":"return {};"}\n\ndata: {"type":"completed","script":"return {};"}\n\n'));
    vi.stubGlobal("fetch", fetch);
    expect(await streamWorkflowScriptAssist(input, undefined, progress)).toEqual({ script: "return {};" });
    expect(progress.mock.calls.map(([event]) => event)).toEqual([{ type: "thinking_delta", delta: "思考" }, { type: "text_delta", delta: "return {};" }]);
    expect(fetch.mock.calls[0]).toEqual(expect.arrayContaining(["/api/v1/workflows/script-assist", expect.objectContaining({ headers: expect.objectContaining({ Accept: "text/event-stream" }) })]));
  });
  it("未收到完成事件的 EOF 和损坏帧明确报错", async () => {
    for (const text of ['data: {"type":"text_delta","delta":"残缺"}\n\n', 'data: broken\n\n', 'data: {"type":"completed"}\n\n']) {
      vi.stubGlobal("fetch", vi.fn(async () => response(text)));
      await expect(streamWorkflowScriptAssist(input)).rejects.toMatchObject({ requestId: "stream-test" });
    }
  });
  it("HTTP 和流内错误保留消息、错误码与请求标识", async () => {
    const error = { code: "REQUEST_FAILED", message: "测试模型输出被截断", requestId: "model-test" };
    for (const reply of [new Response(JSON.stringify({ error }), { status: 502 }), response(`data: ${JSON.stringify({ type: "error", error })}\n\n`)]) {
      vi.stubGlobal("fetch", vi.fn(async () => reply));
      await expect(streamWorkflowScriptAssist(input)).rejects.toMatchObject(error);
    }
  });
  it("取消读取中请求不会被转换成网络错误", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort();
      throw new Error("cancelled transport");
    }));
    await expect(streamWorkflowScriptAssist(input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
