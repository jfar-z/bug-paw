import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { AskUserRunState } from "./ask-user-run-state";

/** 运行时注册的隐藏提问消息防护扩展。 */
export interface AskUserMessageGuardExtension {
  name: string;
  hidden: true;
  factory: ExtensionFactory;
}

/**
 * 规范化包含 ask_user 的 Assistant 消息。
 *
 * 保留首个提问之前的文本和思考，删除全部普通工具以及首个提问后的内容。
 */
export function normalizeAskUserAssistantMessage(
  message: unknown,
): { role: "assistant"; content: unknown[]; [key: string]: unknown } | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const firstAskIndex = message.content.findIndex((block) => isToolCall(block, "ask_user"));
  if (firstAskIndex < 0) return undefined;

  const retained = message.content
    .slice(0, firstAskIndex)
    .filter((block) => !isToolCall(block))
    .map((block) => structuredClone(block));
  retained.push(structuredClone(message.content[firstAskIndex]));
  return { ...message, role: "assistant", content: retained };
}

/** 创建在消息持久化和工具执行前应用的隐藏防护扩展。 */
export function createAskUserMessageGuardExtension(
  state: AskUserRunState,
): AskUserMessageGuardExtension {
  return {
    name: "bug-paw-ask-user-message-guard",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", () => {
        state.reset();
      });
      pi.on("message_end", (event) => {
        const message = normalizeAskUserAssistantMessage(event.message);
        return message ? { message: message as unknown as typeof event.message } : undefined;
      });
    },
  };
}

function isToolCall(value: unknown, name?: string): boolean {
  return isRecord(value)
    && value.type === "toolCall"
    && (name === undefined || value.name === name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
