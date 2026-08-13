export const MODEL_REQUEST_FAILED_MESSAGE = "模型请求失败";
export const MODEL_RESPONSE_TRUNCATED_MESSAGE = "回答因达到长度限制而被截断";

export type AssistantRunOutcome =
  | { status: "completed" }
  | { status: "completed"; notice: string }
  | { status: "aborted" }
  | { status: "error"; message: string };

/** 根据当前分支最新会话消息判断本轮公开终止状态。 */
export function classifyAssistantRunOutcome(messages: readonly unknown[]): AssistantRunOutcome {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    try {
      if (message.role === "user") return { status: "completed" };
      if (message.role !== "assistant") continue;
      if (message.stopReason === "error") {
        return { status: "error", message: MODEL_REQUEST_FAILED_MESSAGE };
      }
      if (message.stopReason === "aborted") return { status: "aborted" };
      if (message.stopReason === "length") {
        return { status: "completed", notice: MODEL_RESPONSE_TRUNCATED_MESSAGE };
      }
      return { status: "completed" };
    } catch {
      // 损坏的历史消息不能阻断 Run 收尾，继续寻找上一条有效会话消息。
    }
  }
  return { status: "completed" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
