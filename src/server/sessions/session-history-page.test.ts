import { describe, expect, it } from "vitest";

import { buildHistoryPageBefore, buildLatestHistoryPage } from "./session-history-page";

function createBranchMessages(turns: number): unknown[] {
  return Array.from({ length: turns }, (_, index) => {
    const number = index + 1;
    return [
      { role: "user", content: `question-${number}`, __piEntryId: `user-${number}` },
      { role: "assistant", content: `answer-${number}`, __piEntryId: `assistant-${number}` },
    ];
  }).flat();
}

describe("当前分支历史分页", () => {
  it("最近页按完整用户轮次切分", () => {
    const page = buildLatestHistoryPage(createBranchMessages(25), "branch-a", "assistant-25");
    expect(page.history).toEqual({
      startEntryId: "user-6",
      endEntryId: "assistant-25",
      branchToken: "branch-a",
      branchLeafId: "assistant-25",
      hasMoreBefore: true,
      turnCount: 20,
    });
    expect(page.messages[0]).toMatchObject({ role: "user" });
  });

  it("上一页不会从工具结果中间开始", () => {
    const messages = Array.from({ length: 45 }, (_, index) => {
      const number = index + 1;
      return [
        { role: "user", __piEntryId: `user-${number}` },
        { role: "assistant", __piEntryId: `assistant-${number}` },
        { role: "toolResult", __piEntryId: `tool-${number}` },
      ];
    }).flat();
    const page = buildHistoryPageBefore(messages, "branch-a", "tool-45", "user-26");
    expect(page.history.turnCount).toBe(20);
    expect(page.messages[0]).toMatchObject({ __piEntryId: "user-6" });
    expect(page.messages.at(-1)).toMatchObject({ __piEntryId: "tool-25" });
  });

  it("到达根部时包含用户轮次前的兼容消息", () => {
    const messages = [
      { role: "assistant", __piEntryId: "legacy-1" },
      ...createBranchMessages(2),
    ];
    const page = buildLatestHistoryPage(messages, "branch-a", "assistant-2");
    expect(page.messages[0]).toMatchObject({ __piEntryId: "legacy-1" });
    expect(page.history).toMatchObject({ startEntryId: "user-1", hasMoreBefore: false, turnCount: 2 });
  });

  it("空会话和无用户消息可以生成稳定空页", () => {
    expect(buildLatestHistoryPage([], "branch-a")).toEqual({
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, turnCount: 0 },
    });
    expect(buildLatestHistoryPage([{ role: "assistant", __piEntryId: "legacy" }], "branch-a").history)
      .toMatchObject({ endEntryId: "legacy", hasMoreBefore: false, turnCount: 0 });
  });

  it("拒绝不存在或不是轮次起点的 before 游标", () => {
    const messages = createBranchMessages(25);
    expect(() => buildHistoryPageBefore(messages, "branch-a", "assistant-25", "missing")).toThrow("历史游标");
    expect(() => buildHistoryPageBefore(messages, "branch-a", "assistant-25", "assistant-20")).toThrow("轮次起点");
  });
});
