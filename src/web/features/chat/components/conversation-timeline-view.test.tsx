import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

describe("ConversationTimelineView 消息排版", () => {
  it("有活动时由本轮活动控制承担唯一分割线", () => {
    const turn: AgentTurn = {
      id: "agent-activity",
      type: "agent",
      sourceUserEntryId: "user-activity",
      blocks: [
        { id: "text", type: "markdown", text: "回答正文", streaming: false },
        { id: "tool", type: "tool", callId: "call", name: "read", args: {}, status: "completed" },
      ],
    };
    render(<ConversationTimelineView {...baseProps()} timeline={[turn]} />);

    expect(screen.getByRole("button", { name: "展开本轮全部活动" }).parentElement)
      .toHaveClass("message-actions--separated");
    expect(screen.getByLabelText("Agent 消息操作"))
      .not.toHaveClass("message-actions--separated");
  });

  it("无活动时保留 Agent 操作区原有分割线", () => {
    render(<ConversationTimelineView {...baseProps()} timeline={[firstTurn]} />);

    expect(screen.getByLabelText("Agent 消息操作"))
      .toHaveClass("message-actions--separated");
  });

  it("用户消息保留原始多行文本并提供专用排版钩子", () => {
    const user: UserEntry = {
      id: "user-multiline",
      type: "user",
      text: "第一行\n  第二行\n第三行",
      files: [],
      references: [],
    };
    const { container } = render(<ConversationTimelineView
      {...baseProps()}
      timeline={[user]}
    />);

    const paragraph = container.querySelector(".user-message-text");
    expect(paragraph?.textContent).toBe("第一行\n  第二行\n第三行");
  });
});

describe("ConversationTimelineView 历史加载状态", () => {
  it("为用户行和 Assistant 正文提供稳定 Session entry 锚点", () => {
    const user: UserEntry = {
      id: "user-local",
      type: "user",
      text: "用户命中",
      files: [],
      references: [],
      piEntryId: "user-25",
    };
    const agent: AgentTurn = {
      id: "agent-local",
      type: "agent",
      blocks: [{ id: "agent-text", type: "markdown", text: "Agent 命中", streaming: false, piEntryId: "assistant-25" }],
    };
    const { container } = render(
      <ConversationTimelineView {...baseProps()} timeline={[user, agent]} focusedEntryId="assistant-25" />,
    );

    expect(container.querySelector('.message-row[data-session-entry-id="user-25"]')).not.toBeNull();
    expect(container.querySelector('.markdown-content[data-session-entry-id="assistant-25"]'))
      .toHaveClass("is-session-search-focus");
  });

  it("聚焦窗口分别展示前后分页状态与返回最新入口", () => {
    const onRetryNewerHistory = vi.fn();
    const onReturnLatest = vi.fn();
    const { rerender } = render(
      <ConversationTimelineView
        {...baseProps()}
        timeline={[firstTurn]}
        focusedHistory
        newerHistoryState="loading"
        onReturnLatest={onReturnLatest}
      />,
    );

    expect(screen.getByRole("status", { name: "正在加载较新消息" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回到最新消息" }));
    expect(onReturnLatest).toHaveBeenCalledOnce();

    rerender(<ConversationTimelineView
      {...baseProps()}
      timeline={[firstTurn]}
      focusedHistory
      newerHistoryState="error"
      onRetryNewerHistory={onRetryNewerHistory}
      onReturnLatest={onReturnLatest}
    />);
    fireEvent.click(screen.getByRole("button", { name: "加载较新消息失败，重试" }));
    expect(onRetryNewerHistory).toHaveBeenCalledOnce();
  });

  it("消息滚动容器保留纵向滚动并允许页面识别横划", () => {
    const { container } = render(<ConversationTimelineView {...baseProps()} timeline={[firstTurn]} />);

    expect(container.querySelector(".message-scroll")).toHaveStyle({ touchAction: "pan-y" });
  });

  it("显示克制的加载状态和可触控重试按钮", () => {
    const onRetryHistory = vi.fn();
    const { rerender } = render(
      <ConversationTimelineView {...baseProps()} timeline={[firstTurn]} historyState="loading" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在加载更早消息");

    rerender(<ConversationTimelineView
      {...baseProps()}
      timeline={[firstTurn]}
      historyState="error"
      onRetryHistory={onRetryHistory}
    />);
    fireEvent.click(screen.getByRole("button", { name: "加载失败，重试" }));
    expect(onRetryHistory).toHaveBeenCalledOnce();
  });
});

describe("ConversationTimelineView 会话切换加载提示", () => {
  it("会话加载完成后先播放退出动画再移除提示", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ConversationTimelineView {...baseProps()} opening />);
      expect(screen.getByRole("status", { name: "正在加载会话" })).toBeInTheDocument();

      rerender(<ConversationTimelineView {...baseProps()} opening={false} />);
      expect(screen.getByRole("status", { name: "正在加载会话" })).toHaveClass("is-leaving");

      act(() => vi.advanceTimersByTime(160));
      expect(screen.queryByRole("status", { name: "正在加载会话" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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
