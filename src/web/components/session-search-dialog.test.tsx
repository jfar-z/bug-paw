import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { SessionSearchDialog } from "./session-search-dialog";

const hits = [{
  sessionId: "session-1",
  sessionName: "历史研究",
  sessionFirstMessage: "第一条",
  archived: true,
  entryId: "assistant-1",
  role: "assistant" as const,
  timestamp: "2026-08-13T08:00:00.000Z",
  snippet: "needle <img src=x>",
  matchRanges: [{ start: 0, end: 6 }],
}, {
  sessionId: "session-2",
  sessionFirstMessage: "第二会话",
  archived: false,
  entryId: "user-2",
  role: "user" as const,
  timestamp: "2026-08-12T08:00:00.000Z",
  snippet: "另一个 needle",
  matchRanges: [{ start: 4, end: 10 }],
}];

describe("SessionSearchDialog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("自动聚焦、延迟搜索、安全高亮并用键盘打开结果", async () => {
    vi.spyOn(api, "searchSessions").mockResolvedValue({ hits, hasMore: false });
    const onSelect = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<SessionSearchDialog open agentId="agent-a" onClose={onClose} onSelect={onSelect} />);
    const input = screen.getByRole("searchbox", { name: "搜索聊天记录" });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "needle" } });
    await act(async () => vi.advanceTimersByTime(300));

    expect(screen.getAllByText("needle", { selector: "mark" })).toHaveLength(2);
    expect(screen.getByText("<img src=x>")).toBeInTheDocument();
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(screen.getByText("历史研究")).toBeInTheDocument();
    expect(screen.getByText("已归档")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("找到 2 条记录");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => Promise.resolve());
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ entryId: "user-2" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Enter 可立即搜索，Escape 关闭且关闭后焦点回到触发按钮", async () => {
    vi.spyOn(api, "searchSessions").mockResolvedValue({ hits: [], hasMore: false });
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "搜索";
    document.body.append(trigger);
    trigger.focus();
    const { rerender } = render(<SessionSearchDialog open agentId="agent-a" onClose={onClose} onSelect={vi.fn()} />);
    const input = screen.getByRole("searchbox", { name: "搜索聊天记录" });
    fireEvent.change(input, { target: { value: "立即" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.searchSessions).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent(/正在搜索|没有找到/);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<SessionSearchDialog open={false} agentId="agent-a" onClose={onClose} onSelect={vi.fn()} />);
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("展示空、错误、继续加载与结果选择失败状态", async () => {
    vi.spyOn(api, "searchSessions")
      .mockResolvedValueOnce({ hits: [], hasMore: false })
      .mockRejectedValueOnce(new Error("网络不可用"))
      .mockResolvedValueOnce({ hits: [hits[0]!], hasMore: true, nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ hits: [hits[1]!], hasMore: false });
    const onSelect = vi.fn(async () => { throw new Error("搜索结果已过期或会话已删除"); });
    render(<SessionSearchDialog open agentId="agent-a" onClose={vi.fn()} onSelect={onSelect} />);
    const input = screen.getByRole("searchbox", { name: "搜索聊天记录" });

    fireEvent.change(input, { target: { value: "empty" } });
    await act(async () => vi.advanceTimersByTime(300));
    expect(screen.getAllByText("没有找到匹配的聊天记录")).toHaveLength(2);

    fireEvent.change(input, { target: { value: "error" } });
    await act(async () => vi.advanceTimersByTime(300));
    expect(screen.getByText("网络不可用")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "more" } });
    await act(async () => vi.advanceTimersByTime(300));
    const listbox = screen.getByRole("listbox", { name: "聊天记录搜索结果" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "加载更多搜索结果" }));
    await act(async () => Promise.resolve());
    expect(within(listbox).getAllByRole("option")).toHaveLength(2);
    fireEvent.click(within(listbox).getAllByRole("option")[0]!);
    await act(async () => Promise.resolve());
    expect(screen.getByText("搜索结果已过期或会话已删除")).toBeInTheDocument();
  });
});
