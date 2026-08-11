import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentTurn, UserEntry } from "../../../conversation-timeline";
import { ConversationTimelineView } from "./conversation-timeline-view";

const firstTurn: AgentTurn = {
  id: "agent-first",
  type: "agent",
  blocks: [{ id: "first-text", type: "markdown", text: "第一条回答。", streaming: false }],
};

const secondTurn: AgentTurn = {
  id: "agent-second",
  type: "agent",
  blocks: [{ id: "second-text", type: "markdown", text: "第二条回答。", streaming: false }],
};

describe("ConversationTimelineView 朗读操作", () => {
  it("为每条 Agent 消息显示纯图标按钮并标记当前活动消息", () => {
    const onToggleSpeech = vi.fn();
    const { rerender } = render(
      <ConversationTimelineView
        {...baseProps()}
        timeline={[firstTurn, secondTurn]}
        speechEnabled
        activeSpeechMessageId="agent-second"
        onToggleSpeech={onToggleSpeech}
      />,
    );

    const start = screen.getByRole("button", { name: "朗读消息" });
    const stop = screen.getByRole("button", { name: "停止朗读" });
    expect(start).toHaveTextContent("");
    expect(stop).toHaveTextContent("");
    expect(screen.getAllByLabelText("Agent 消息操作")).toHaveLength(2);

    fireEvent.click(start);
    expect(onToggleSpeech).toHaveBeenCalledWith(firstTurn);

    rerender(
      <ConversationTimelineView
        {...baseProps()}
        timeline={[firstTurn, secondTurn]}
        speechEnabled={false}
        onToggleSpeech={onToggleSpeech}
      />,
    );
    expect(screen.queryByRole("button", { name: "朗读消息" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止朗读" })).not.toBeInTheDocument();
  });

  it("当前流式消息没有稳定片段时禁用朗读", () => {
    const streamingTurn: AgentTurn = {
      id: "agent-streaming",
      type: "agent",
      blocks: [{ id: "streaming-text", type: "markdown", text: "正在生成", streaming: true }],
    };
    render(
      <ConversationTimelineView
        {...baseProps()}
        timeline={[streamingTurn]}
        streaming
        activeAgentEntryId="agent-streaming"
        speechEnabled
        onToggleSpeech={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "朗读消息" })).toBeDisabled();
  });

  it("朗读操作区标记为与正文分隔的可扩展底栏", () => {
    render(
      <ConversationTimelineView
        {...baseProps()}
        timeline={[firstTurn]}
        speechEnabled
        onToggleSpeech={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Agent 消息操作"))
      .toHaveClass("message-actions--separated");
  });
});

describe("ConversationTimelineView 消息复制", () => {
  it("用户消息复制纯文本，Agent 消息复制最后一个正文段", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const user: UserEntry = {
      id: "user-1",
      type: "user",
      text: "用户正文",
      files: [{ path: "image.png" }],
      references: [],
      piEntryId: "pi-user-1",
    };
    const agent: AgentTurn = {
      id: "agent-1",
      type: "agent",
      blocks: [
        { id: "text-1", type: "markdown", text: "工具前文本", streaming: false },
        { id: "tool-1", type: "tool", callId: "call-1", name: "read", args: {}, status: "completed" },
        { id: "text-2", type: "markdown", text: "最终正文", streaming: false },
      ],
    };
    render(<ConversationTimelineView {...baseProps()} timeline={[user, agent]} speechEnabled={false} />);

    const copyButtons = screen.getAllByRole("button", { name: "复制消息" });
    fireEvent.click(copyButtons[0]!);
    fireEvent.click(copyButtons[1]!);

    expect(writeText).toHaveBeenNthCalledWith(1, "用户正文");
    expect(writeText).toHaveBeenNthCalledWith(2, "最终正文");
    expect(await screen.findAllByRole("button", { name: "已复制" })).toHaveLength(2);
  });

  it("没有正文的 Agent 消息不显示复制操作", () => {
    const toolOnly: AgentTurn = {
      id: "agent-tool-only",
      type: "agent",
      blocks: [{ id: "tool-1", type: "tool", callId: "call-1", name: "read", args: {}, status: "completed" }],
    };

    render(<ConversationTimelineView {...baseProps()} timeline={[toolOnly]} speechEnabled={false} />);

    expect(screen.queryByRole("button", { name: "复制消息" })).not.toBeInTheDocument();
  });
});

/** 创建不影响朗读行为的最小时间线属性。 */
function baseProps() {
  return {
    timeline: [] as AgentTurn[],
    theme: "light" as const,
    noAvailableAgent: false,
    streaming: false,
    opening: false,
    profileIdentity: { displayName: "管理员", avatarText: "管" },
    navigationItems: [],
    scrollRef: createRef<HTMLDivElement>(),
    contentRef: createRef<HTMLDivElement>(),
    speechEnabled: true,
    onResolved: vi.fn(),
    onPreview: vi.fn(),
    onCreateAgent: vi.fn(),
    onToggleSpeech: vi.fn(),
  };
}
