import { SYSTEM_LIMITS } from "../core/limits";
import {
  MODEL_REQUEST_FAILED_MESSAGE,
  MODEL_RESPONSE_TRUNCATED_MESSAGE,
} from "../../shared/assistant-run-outcome";

const IMAGE_PLACEHOLDER = "<IMAGE_BASE64>";
const TOOL_TEXT_PLACEHOLDER = "<TOOL_RESULT_TOO_LONG>";

/**
 * 创建仅供浏览器展示的消息副本，完整 Pi 消息和 JSONL 不会被修改。
 */
export function projectSessionMessages(messages: readonly unknown[]): unknown[] {
  let retainedToolTextBytes = 0;
  return messages.map((message) => {
    if (!isRecord(message)) return message;
    const projected = { ...message };
    if (message.role === "assistant" && message.stopReason === "error") {
      projected.errorMessage = MODEL_REQUEST_FAILED_MESSAGE;
    } else if (message.role === "assistant" && message.stopReason === "length") {
      projected.errorMessage = MODEL_RESPONSE_TRUNCATED_MESSAGE;
    }
    if (message.role !== "toolResult" || !Array.isArray(message.content)) return projected;
    projected.content = message.content.map((block) => {
      try {
        if (!isRecord(block)) return block;
        if (block.type === "image" && typeof block.data === "string") {
          return {
            ...block,
            data: IMAGE_PLACEHOLDER,
            originalBytes: Buffer.byteLength(block.data, "utf8"),
          };
        }
        if (block.type === "text" && typeof block.text === "string") {
          const originalBytes = Buffer.byteLength(block.text, "utf8");
          if (originalBytes > SYSTEM_LIMITS.sessionToolTextBlockBytes
            || retainedToolTextBytes + originalBytes > SYSTEM_LIMITS.sessionToolTextPageBytes) {
            return truncatedToolText(originalBytes);
          }
          retainedToolTextBytes += originalBytes;
          return { ...block };
        }
        return { ...block };
      } catch {
        // 异常 getter 或损坏块不能阻断整个会话快照。
        return truncatedToolText(0);
      }
    });
    return projected;
  });
}

/** 对实时工具完成事件应用与历史快照相同的展示边界。 */
export function projectSessionToolResult(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const projected = projectSessionMessages([{ ...result, role: "toolResult" }])[0];
  if (!isRecord(projected)) return projected;
  const { role: _role, ...withoutInjectedRole } = projected;
  return withoutInjectedRole;
}

function truncatedToolText(originalBytes: number): Record<string, unknown> {
  return {
    type: "text",
    text: TOOL_TEXT_PLACEHOLDER,
    truncated: true,
    originalBytes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
