// @vitest-environment node

import { describe, expect, it } from "vitest";

import { AskUserRunState } from "./ask-user-run-state";
import { normalizeAskUserAssistantMessage } from "./ask-user-message-guard";

describe("ask_user Assistant 消息防护", () => {
  it("只保留首个 ask_user 之前的说明和该次调用", () => {
    const original = {
      role: "assistant",
      content: [
        { type: "text", text: "前置说明" },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "a" } },
        { type: "thinking", thinking: "需要确认" },
        { type: "toolCall", id: "ask-1", name: "ask_user", arguments: { questions: [] } },
        { type: "text", text: "尾随说明" },
        { type: "toolCall", id: "ask-2", name: "ask_user", arguments: { questions: [] } },
        { type: "toolCall", id: "write-1", name: "write", arguments: { path: "a" } },
      ],
      stopReason: "toolUse",
      timestamp: 1,
    };

    const normalized = normalizeAskUserAssistantMessage(original as never);

    expect(normalized?.content).toEqual([
      { type: "text", text: "前置说明" },
      { type: "thinking", thinking: "需要确认" },
      { type: "toolCall", id: "ask-1", name: "ask_user", arguments: { questions: [] } },
    ]);
    expect(original.content).toHaveLength(7);
  });

  it("没有 ask_user 时不替换消息", () => {
    expect(normalizeAskUserAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "正常回答" }],
    } as never)).toBeUndefined();
  });

  it("提问开始后抑制尾随文本和兄弟工具，失败后允许模型纠正", () => {
    const state = new AskUserRunState();
    state.observeToolCallStart("ask-1", "ask_user");

    expect(state.shouldPublish(messageUpdate("text_delta"))).toBe(false);
    expect(state.shouldPublish(messageUpdate("toolcall_delta", "ask-1", "ask_user"))).toBe(true);
    expect(state.shouldPublish(messageUpdate("toolcall_start", "write-1", "write"))).toBe(false);
    expect(state.shouldPublish(toolExecution("tool_execution_start", "write-1", "write"))).toBe(false);
    expect(state.shouldPublish(toolExecution("tool_execution_start", "ask-1", "ask_user"))).toBe(true);

    state.finishTool("ask-1", true);
    expect(state.shouldPublish(messageUpdate("text_delta"))).toBe(true);
  });
});

function messageUpdate(type: string, id = "", name = "") {
  const content = id ? [{ type: "toolCall", id, name, arguments: {} }] : [{ type: "text", text: "尾随" }];
  return {
    type: "message_update",
    message: { role: "assistant", content },
    assistantMessageEvent: {
      type,
      contentIndex: 0,
      delta: "x",
      toolCall: { id, name, arguments: {} },
    },
  } as never;
}

function toolExecution(type: string, toolCallId: string, toolName: string) {
  return { type, toolCallId, toolName, args: {} } as never;
}
