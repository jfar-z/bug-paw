import type { WorkflowScriptAssistProgress } from "../../../shared/workflow-contracts";
import { ApiClientError } from "../../api";

/** 读取一次 POST 生成流；收到完成事件前断流必须报错，不能应用残缺代码。 */
export async function readWorkflowScriptAssistStream(
  response: Response,
  signal: AbortSignal,
  onProgress?: (event: WorkflowScriptAssistProgress) => void,
): Promise<{ script: string }> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const requestId = response.headers.get("X-Request-Id") ?? undefined;
  const invalid = (message: string) => new ApiClientError("API_RESPONSE_INVALID", message, 200, requestId);
  try {
    if (!response.ok) {
      let payload: unknown;
      try { payload = JSON.parse(await response.text()); }
      catch { throw new ApiClientError("API_RESPONSE_INVALID", `脚本辅助接口返回非 JSON 错误响应（HTTP ${response.status}）`, response.status, requestId); }
      throw streamError(payload, response.status, requestId);
    }
    if (!response.headers.get("Content-Type")?.includes("text/event-stream") || !response.body)
      throw invalid("脚本辅助接口未返回可读取的事件流");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        let event: unknown;
        try { event = JSON.parse(data); }
        catch { throw invalid("脚本辅助事件流包含无法解析的 JSON"); }
        if (!record(event)) throw invalid("脚本辅助事件格式不合法");
        if (event.type === "error") throw streamError(event, 200, requestId);
        if (event.type === "completed") {
          if (typeof event.script !== "string" || !event.script.trim() || event.script.length > 20_000)
            throw invalid("脚本辅助完成事件缺少有效脚本");
          return { script: event.script };
        }
        if (event.type === "started" || event.type === "validating") onProgress?.({ type: event.type });
        else if ((event.type === "thinking_delta" || event.type === "text_delta") && typeof event.delta === "string")
          onProgress?.({ type: event.type, delta: event.delta });
        else throw invalid("脚本辅助事件类型或文字增量不合法");
      }
      if (buffer.length > 1_048_576) throw invalid("脚本辅助事件超过可读取大小");
      if (chunk.done) throw new ApiClientError("REQUEST_FAILED", "脚本辅助连接在生成完成前中断，请重新生成", 200, requestId);
    }
  } finally {
    reader?.releaseLock();
  }
}

/** HTTP 与流内错误共用错误码和请求标识，交由全局错误弹窗展示。 */
function streamError(payload: unknown, status: number, requestId?: string): ApiClientError {
  const error = record(payload) && record(payload.error) ? payload.error : undefined;
  if (!error || typeof error.code !== "string" || typeof error.message !== "string")
    return new ApiClientError("API_RESPONSE_INVALID", `脚本辅助错误响应缺少错误码或消息（HTTP ${status}）`, status, requestId);
  return new ApiClientError(error.code, error.message, status,
    typeof error.requestId === "string" ? error.requestId : requestId,
    record(error.details) ? error.details : undefined);
}

/** 校验网络输入对象，防止损坏帧进入界面状态。 */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
