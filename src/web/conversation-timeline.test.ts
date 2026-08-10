import { describe, expect, it } from "vitest";
import {
  formatToolValue,
  parsePiHistory,
  reduceTimeline,
  type AgentTurn,
  type ConversationEntry,
  type TimelineEvent,
} from "./conversation-timeline";

function reduceEvents(events: TimelineEvent[]): ConversationEntry[] {
  return events.reduce(reduceTimeline, [] as ConversationEntry[]);
}

describe("对话时间线", () => {
  it("生成开始时立即创建唯一的空 Agent 回合", () => {
    const user: ConversationEntry = { id: "user-1", type: "user", text: "你好", files: [], references: [] };

    const started = reduceTimeline([user], { type: "generation_started" });
    const duplicate = reduceTimeline(started, { type: "generation_started" });

    expect(started.at(-1)).toMatchObject({ type: "agent", blocks: [] });
    expect(duplicate).toHaveLength(2);
  });

  it("按文本、工具、文本、工具的实时顺序归并", () => {
    const entries = reduceEvents([
      { type: "text_delta", delta: "先说明" },
      { type: "tool_started", callId: "tool-1", toolName: "bash", args: { cmd: "pwd" } },
      { type: "tool_updated", callId: "tool-1", toolName: "bash", partialResult: "执行中" },
      { type: "tool_finished", callId: "tool-1", toolName: "bash", result: "/data/workspace", isError: false },
      { type: "text_delta", delta: "再说明" },
      { type: "tool_started", callId: "tool-2", toolName: "read", args: { path: "AGENTS.md" } },
    ]);

    const turn = entries[0] as AgentTurn;
    expect(turn.blocks.map((block) => block.type)).toEqual(["markdown", "tool", "markdown", "tool"]);
    expect(turn.blocks[0]).toMatchObject({ text: "先说明" });
    expect(turn.blocks[1]).toMatchObject({ args: { cmd: "pwd" }, result: "/data/workspace", status: "completed" });
    expect(turn.blocks[2]).toMatchObject({ text: "再说明" });
  });

  it("按思考、工具和正文的到达顺序归并，并在结束后折叠思考流", () => {
    const entries = reduceEvents([
      { type: "thinking_delta", delta: "先检查上下文" },
      { type: "thinking_delta", delta: "，再调用工具" },
      { type: "tool_started", callId: "tool-1", toolName: "read", args: { path: "AGENTS.md" } },
      { type: "text_delta", delta: "已读取配置。" },
      { type: "generation_finished" },
    ]);

    const turn = entries[0] as AgentTurn;
    expect(turn.blocks.map((block) => block.type)).toEqual(["thinking", "tool", "markdown"]);
    expect(turn.blocks[0]).toMatchObject({ text: "先检查上下文，再调用工具", streaming: false });
  });

  it("单段思考结束时立即折叠，并允许后续思考重新展开", () => {
    const entries = reduceEvents([
      { type: "thinking_delta", delta: "先检查上下文" },
      { type: "thinking_finished" },
      { type: "tool_started", callId: "tool-1", toolName: "read", args: { path: "AGENTS.md" } },
      { type: "thinking_delta", delta: "根据结果继续判断" },
    ]);

    const turn = entries[0] as AgentTurn;
    expect(turn.blocks.map((block) => block.type)).toEqual(["thinking", "tool", "thinking"]);
    expect(turn.blocks[0]).toMatchObject({ text: "先检查上下文", streaming: false });
    expect(turn.blocks[2]).toMatchObject({ text: "根据结果继续判断", streaming: true });
  });

  it("从历史 Assistant 内容恢复思考块", () => {
    const entries = parsePiHistory([{ role: "assistant", content: [
      { type: "thinking", thinking: "先判断输入" },
      { type: "text", text: "这是结论。" },
    ] }]);

    expect((entries[0] as AgentTurn).blocks.map((block) => block.type)).toEqual(["thinking", "markdown"]);
  });

  it("连续文本增量拼接且重复工具开始事件不会产生重复卡片", () => {
    const entries = reduceEvents([
      { type: "text_delta", delta: "第一段" },
      { type: "text_delta", delta: "继续" },
      { type: "tool_started", callId: "tool-1", toolName: "bash", args: { cmd: "pwd" } },
      { type: "tool_started", callId: "tool-1", toolName: "bash", args: { cmd: "pwd -P" } },
      { type: "generation_finished" },
    ]);

    const turn = entries[0] as AgentTurn;
    expect(turn.blocks).toHaveLength(2);
    expect(turn.blocks[0]).toMatchObject({ type: "markdown", text: "第一段继续", streaming: false });
    expect(turn.blocks[1]).toMatchObject({ type: "tool", args: { cmd: "pwd -P" } });
  });

  it("连续文本增量保持流式 Markdown 块标识稳定", () => {
    const first = reduceTimeline([], { type: "text_delta", delta: "第一段" });
    const firstBlock = (first[0] as AgentTurn).blocks[0];

    const second = reduceTimeline(first, { type: "text_delta", delta: "继续" });
    const secondBlock = (second[0] as AgentTurn).blocks[0];

    expect(secondBlock.id).toBe(firstBlock.id);
    expect(firstBlock).toMatchObject({ revealStart: 0, revealPhase: 0 });
    expect(secondBlock).toMatchObject({
      type: "markdown",
      text: "第一段继续",
      streaming: true,
      revealStart: "第一段".length,
      revealPhase: 1,
    });
  });

  it("工具调用后的流式标题保留与正文之间的空行", () => {
    const entries = reduceEvents([
      { type: "tool_started", callId: "tool-1", toolName: "read", args: { path: "attachments/a.md" } },
      { type: "tool_finished", callId: "tool-1", toolName: "read", result: "读取完成", isError: false },
      { type: "text_delta", delta: "## 总结\n\n" },
      { type: "text_delta", delta: "这是正文。" },
    ]);

    const turn = entries[0] as AgentTurn;
    expect(turn.blocks.at(-1)).toMatchObject({
      type: "markdown",
      text: "## 总结\n\n这是正文。",
      streaming: true,
    });
  });

  it("活动 snapshot 的部分回答继续接收新 token 而不拆成两段", () => {
    const restored = parsePiHistory([{
      role: "assistant",
      content: [{ type: "text", text: "刷新前" }],
    }], true);

    const continued = reduceTimeline(restored, { type: "text_delta", delta: "刷新后" });

    expect(continued).toHaveLength(1);
    expect(continued[0]).toMatchObject({
      type: "agent",
      blocks: [{ type: "markdown", text: "刷新前刷新后", streaming: true }],
    });
  });

  it("从 pi 历史恢复工具时序、入参和结果", () => {
    const entries = parsePiHistory([
      { role: "user", content: "开始检查", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "先检查目录" },
          { type: "toolCall", id: "tool-1", name: "bash", arguments: { cmd: "pwd" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "bash",
        content: [{ type: "text", text: "/data/workspace" }],
        details: { exitCode: 0 },
        isError: false,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "再读取文件" },
          { type: "toolCall", id: "tool-2", name: "read", arguments: { path: "AGENTS.md" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tool-2",
        toolName: "read",
        content: [{ type: "text", text: "项目目标" }],
        isError: true,
      },
    ]);

    expect(entries[0]).toMatchObject({ type: "user", text: "开始检查" });
    const turn = entries[1] as AgentTurn;
    expect(turn.blocks.map((block) => block.type)).toEqual(["markdown", "tool", "markdown", "tool"]);
    expect(turn.blocks[1]).toMatchObject({
      callId: "tool-1",
      args: { cmd: "pwd" },
      result: "/data/workspace",
      details: { exitCode: 0 },
      status: "completed",
    });
    expect(turn.blocks[3]).toMatchObject({ result: "项目目标", status: "error" });
  });

  it("标记定时任务发出的会话消息", () => {
    const entries = parsePiHistory([{ role: "user", content: "这是定时任务发出的消息\n\n整理日报" }]);
    expect(entries[0]).toMatchObject({ type: "user", source: "scheduled" });
  });

  it("保留找不到调用记录的孤立工具结果", () => {
    const entries = parsePiHistory([
      {
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "bash",
        content: [{ type: "text", text: "仍需展示" }],
        isError: false,
      },
    ]);

    const turn = entries[0] as AgentTurn;
    expect(turn.blocks[0]).toMatchObject({ callId: "orphan", name: "bash", result: "仍需展示" });
  });

  it("安全格式化结构化值和循环引用", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(formatToolValue({ cmd: "pwd" })).toBe('{\n  "cmd": "pwd"\n}');
    expect(formatToolValue("plain")).toBe("plain");
    expect(formatToolValue(circular)).toContain("[无法序列化]");
  });

  it("将实时工具的 content 和 details 归一化为历史恢复格式", () => {
    const entries = reduceEvents([
      { type: "tool_started", callId: "tool-1", toolName: "bash", args: { cmd: "pwd" } },
      {
        type: "tool_finished",
        callId: "tool-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "/data/workspace" }], details: { exitCode: 0 } },
        isError: false,
      },
    ]);

    const turn = entries[0] as AgentTurn;
    expect(turn.blocks[0]).toMatchObject({ result: "/data/workspace", details: { exitCode: 0 } });
  });

  it("从用户历史中隐藏统一文件块并恢复相对路径", () => {
    const content = [
      "分析图片",
      "",
      '<pi_agent_files version="1">',
      JSON.stringify({
        files: [{ path: "attachments/示例.png" }],
      }, null, 2),
      "</pi_agent_files>",
    ].join("\n");

    const entries = parsePiHistory([{ role: "user", content }]);

    expect(entries[0]).toMatchObject({
      type: "user",
      text: "分析图片",
      files: [{ path: "attachments/示例.png" }],
    });
  });

  it("从用户历史中恢复通用引用并保留文件附件", () => {
    const content = [
      "请分析这些资料",
      "",
      '<agent_references version="1" type="skill" name="knowledge-base"/>',
      '<agent_references version="1" type="knowledge" id="kb-1" name="产品资料"/>',
      '<agent_references version="1" type="file" path="docs/spec.md" kind="file"/>',
    ].join("\n");

    const entries = parsePiHistory([{ role: "user", content }]);

    expect(entries[0]).toMatchObject({
      type: "user",
      text: "请分析这些资料",
      files: [{ path: "docs/spec.md" }],
      references: [
        { type: "skill", name: "knowledge-base" },
        { type: "knowledge", id: "kb-1", name: "产品资料" },
        { type: "file", path: "docs/spec.md", kind: "file", name: "spec.md" },
      ],
    });
  });

  it("内部文件块损坏时保守保留原文", () => {
    const content = '消息\n\n<pi_agent_files version="1">\n{broken}\n</pi_agent_files>';
    const entries = parsePiHistory([{ role: "user", content }]);

    expect(entries[0]).toMatchObject({ type: "user", text: content });
  });

  it("按 Agent 文本中的原始位置恢复文件块", () => {
    const text = [
      "先说明",
      "",
      '<pi_agent_files version="1">',
      '{"files":[{"path":"outputs/演示.mp4"}]}',
      "</pi_agent_files>",
      "",
      "再说明",
    ].join("\n");
    const entries = parsePiHistory([{ role: "assistant", content: [{ type: "text", text }] }]);

    const turn = entries[0] as AgentTurn;
    expect(turn.blocks.map((block) => block.type)).toEqual(["markdown", "files", "markdown"]);
    expect(turn.blocks[0]).toMatchObject({ text: "先说明" });
    expect(turn.blocks[1]).toMatchObject({ files: [{ path: "outputs/演示.mp4" }] });
    expect(turn.blocks[2]).toMatchObject({ text: "再说明" });
  });

  it("流式补全文件块后从 Markdown 转为有序文件块", () => {
    const entries = reduceEvents([
      { type: "text_delta", delta: '开始\n\n<pi_agent_files version="1">\n{"files":[{"path":"outputs/a.png"}]}' },
      { type: "text_delta", delta: "\n</pi_agent_files>\n\n完成" },
    ]);

    const turn = entries[0] as AgentTurn;
    expect(turn.blocks.map((block) => block.type)).toEqual(["markdown", "files", "markdown"]);
    expect(turn.blocks[2]).toMatchObject({ text: "完成", streaming: true });
  });

  it("文件协议结束标签跨增量时立即转换且生成结束后保持文件块", () => {
    const entries = reduceEvents([
      { type: "text_delta", delta: '<pi_agent_files version="1">\n{"files":[{"path":"outputs/a.png"}]}\n' },
      { type: "text_delta", delta: "</pi_agent_files>" },
      { type: "generation_finished" },
    ]);

    const turn = entries[0] as AgentTurn;
    expect(turn.blocks).toMatchObject([
      { type: "files", files: [{ path: "outputs/a.png" }] },
    ]);
  });
});
