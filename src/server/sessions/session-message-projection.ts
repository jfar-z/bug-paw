import { SYSTEM_LIMITS } from "../core/limits";
import {
  MODEL_REQUEST_FAILED_MESSAGE,
  MODEL_RESPONSE_TRUNCATED_MESSAGE,
} from "../../shared/assistant-run-outcome";
import {
  parseQuestionResponseProtocol,
  type QuestionResolution,
} from "../../shared/question-response-protocol";

const IMAGE_PLACEHOLDER = "<IMAGE_BASE64>";
const TOOL_TEXT_PLACEHOLDER = "<TOOL_RESULT_TOO_LONG>";

export interface SessionMessageProjectionOptions {
  /**
   * 用于恢复提问终态的完整当前分支消息；分页展示时可与待投影消息不同。
   */
  questionResolutionMessages?: readonly unknown[];
}

/**
 * 创建仅供浏览器展示的消息副本，完整 Pi 消息和 JSONL 不会被修改。
 */
export function projectSessionMessages(
  messages: readonly unknown[],
  options: SessionMessageProjectionOptions = {},
): unknown[] {
  let retainedToolTextBytes = 0;
  const questionResolutions = collectQuestionResolutions(options.questionResolutionMessages ?? messages);
  return messages.map((message) => {
    if (!isRecord(message)) return message;
    const projected = { ...message };
    if (message.role === "assistant" && message.stopReason === "error") {
      projected.errorMessage = MODEL_REQUEST_FAILED_MESSAGE;
    } else if (message.role === "assistant" && message.stopReason === "length") {
      projected.errorMessage = MODEL_RESPONSE_TRUNCATED_MESSAGE;
    }
    if (message.role === "user") {
      if (typeof message.content === "string") {
        projected.content = parseQuestionResponseProtocol(message.content).visibleText;
      } else if (Array.isArray(message.content)) {
        projected.content = message.content.map((block) => isRecord(block)
          && block.type === "text"
          && typeof block.text === "string"
          ? { ...block, text: parseQuestionResponseProtocol(block.text).visibleText }
          : block);
      }
    }
    if (message.role === "toolResult"
      && message.toolName === "ask_user"
      && message.isError === false
      && isRecord(message.details)
      && isRecord(message.details.pendingQuestion)
      && typeof message.details.pendingQuestion.id === "string") {
      const resolution = questionResolutions.get(message.details.pendingQuestion.id);
      if (resolution) projected.details = { ...message.details, resolution };
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

/** 收集当前 Pi 分支中的回答事实，较晚消息覆盖同一问题的较早事实。 */
function collectQuestionResolutions(messages: readonly unknown[]): Map<string, QuestionResolution> {
  const resolutions = new Map<string, QuestionResolution>();
  for (const message of messages) {
    try {
      if (!isRecord(message) || message.role !== "user") continue;
      for (const text of readUserText(message.content)) {
        const resolution = parseQuestionResponseProtocol(text).resolution;
        if (resolution) resolutions.set(resolution.questionRecordId, resolution);
      }
    } catch {
      // 单条损坏消息不能阻断其余会话的浏览器投影。
    }
  }
  return resolutions;
}

function readUserText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => isRecord(block)
    && block.type === "text"
    && typeof block.text === "string"
    ? [block.text]
    : []);
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
