import { describe, expect, it } from "vitest";

import type { AgentTurn, UserEntry } from "../../conversation-timeline";
import { copyTextForEntry } from "./message-copy";

describe("消息复制文本提取", () => {
  it("用户消息只复制原始文本，不包含引用与附件", () => {
    const entry: UserEntry = {
      id: "user-1",
      type: "user",
      text: "请检查这份材料。",
      files: [{ path: "uploads/example.png" }],
      references: [{ type: "skill", name: "review" }],
    };

    expect(copyTextForEntry(entry)).toBe("请检查这份材料。");
  });

  it("Agent 消息只复制工具调用后的最后一段文本", () => {
    const entry: AgentTurn = {
      id: "agent-1",
      type: "agent",
      blocks: [
        { id: "text-1", type: "markdown", text: "我先检查文件。", streaming: false },
        { id: "tool-1", type: "tool", callId: "call-1", name: "read", args: {}, status: "completed", result: "工具结果" },
        { id: "text-2", type: "markdown", text: "检查完成，没有发现问题。", streaming: false },
        { id: "files-1", type: "files", files: [{ path: "report.txt" }] },
      ],
    };

    expect(copyTextForEntry(entry)).toBe("检查完成，没有发现问题。");
  });

  it("忽略末尾空文本段并在没有正文时返回空字符串", () => {
    const withEmptyTail: AgentTurn = {
      id: "agent-2",
      type: "agent",
      blocks: [
        { id: "text-1", type: "markdown", text: "最终文本", streaming: false },
        { id: "text-2", type: "markdown", text: "   ", streaming: false },
      ],
    };
    const toolOnly: AgentTurn = {
      id: "agent-3",
      type: "agent",
      blocks: [{ id: "tool-1", type: "tool", callId: "call-1", name: "read", args: {}, status: "completed" }],
    };

    expect(copyTextForEntry(withEmptyTail)).toBe("最终文本");
    expect(copyTextForEntry(toolOnly)).toBe("");
  });
});
