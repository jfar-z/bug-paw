import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentTurn } from "../../../conversation-timeline";
import { AgentTurnContent } from "./agent-turn-content";

const turn: AgentTurn = {
  id: "turn-1",
  type: "agent",
  blocks: [
    { id: "m1", type: "markdown", text: "第一段正文", streaming: false },
    { id: "t1", type: "thinking", text: "分析", streaming: false },
    { id: "r1", type: "tool", callId: "call-r1", name: "read", args: { path: "README.md" }, status: "completed" },
    { id: "m2", type: "markdown", text: "第二段正文", streaming: false },
    { id: "w1", type: "tool", callId: "call-w1", name: "write", args: { path: "src/app.ts" }, status: "running" },
  ],
};

describe("AgentTurnContent", () => {
  it("未指定搜索焦点时不高亮尚无 Pi entry ID 的流式正文", () => {
    const streamingTurn: AgentTurn = {
      id: "streaming-turn",
      type: "agent",
      blocks: [{ id: "streaming-markdown", type: "markdown", text: "正在生成回答", streaming: true }],
    };
    const { container } = render(<AgentTurnContent
      turn={streamingTurn}
      streaming
      theme="light"
      onResolved={vi.fn()}
      onPreview={vi.fn()}
    />);

    expect(container.querySelector(".markdown-content")).not.toHaveClass("is-session-search-focus");
  });

  it("按正文与活动段的原始顺序渲染并支持本轮整体折叠", () => {
    render(<AgentTurnContent
      turn={turn}
      streaming
      theme="light"
      onResolved={vi.fn()}
      onPreview={vi.fn()}
    />);

    const first = screen.getByText("第一段正文");
    const firstActivity = screen.getByRole("button", { name: "展开活动段：已完成 2 项活动" });
    const second = screen.getByText("第二段正文");
    const secondActivity = screen.getByRole("button", { name: "收起活动段：写入 src/app.ts" });
    expect(first.compareDocumentPosition(firstActivity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(firstActivity.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(secondActivity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const activityControls = screen.getByRole("button", { name: "收起本轮全部活动" }).parentElement;
    const sharedFooter = activityControls?.parentElement;
    expect(activityControls).toHaveClass("agent-turn-activity-controls");
    expect(sharedFooter).toHaveClass("agent-turn-footer", "message-actions--separated");
    expect(secondActivity.compareDocumentPosition(sharedFooter!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "收起本轮全部活动" }));
    expect(screen.getByText("第一段正文")).toBeVisible();
    expect(screen.getByText("第二段正文")).toBeVisible();
    expect(screen.getByRole("button", { name: "展开活动段：写入 src/app.ts" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "展开本轮全部活动" }));
    expect(screen.getByRole("button", { name: "收起活动段：已完成 2 项活动" })).toHaveAttribute("aria-expanded", "true");
  });
});
