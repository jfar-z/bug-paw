import { describe, expect, it } from "vitest";

import * as historyPage from "./session-history-page";

const { buildHistoryPageBefore, buildLatestHistoryPage } = historyPage;
const { buildHistoryPageAfter, buildHistoryPageAround } = historyPage;

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
  it("提供目标窗口和向后分页构造器", () => {
    expect((historyPage as Record<string, unknown>).buildHistoryPageAround).toBeTypeOf("function");
    expect((historyPage as Record<string, unknown>).buildHistoryPageAfter).toBeTypeOf("function");
  });

  it("最近页按完整用户轮次切分", () => {
    const page = buildLatestHistoryPage(createBranchMessages(25), "branch-a", "assistant-25");
    expect(page.history).toEqual({
      startEntryId: "user-6",
      endEntryId: "assistant-25",
      branchToken: "branch-a",
      branchLeafId: "assistant-25",
      hasMoreBefore: true,
      hasMoreAfter: false,
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
    expect(page.history.hasMoreAfter).toBe(true);
    expect(page.messages[0]).toMatchObject({ __piEntryId: "user-6" });
    expect(page.messages.at(-1)).toMatchObject({ __piEntryId: "tool-25" });
  });

  it("围绕助手文本命中返回二十个完整用户轮次", () => {
    const page = buildHistoryPageAround(
      createBranchMessages(50),
      "branch-a",
      "assistant-50",
      "assistant-25",
    );

    expect(page.history).toMatchObject({
      startEntryId: "user-15",
      endEntryId: "assistant-34",
      hasMoreBefore: true,
      hasMoreAfter: true,
      turnCount: 20,
    });
    expect(page.targetEntryId).toBe("assistant-25");
    expect(page.messages).toContainEqual(expect.objectContaining({ __piEntryId: "assistant-25" }));
  });

  it("目标窗口拒绝不存在、工具或不可见助手 entry", () => {
    const messages = [
      { role: "user", content: "问题", __piEntryId: "user-1" },
      { role: "assistant", content: [{ type: "thinking", thinking: "仅思考" }], __piEntryId: "assistant-thinking" },
      { role: "toolResult", content: "结果", __piEntryId: "tool-1" },
    ];

    expect(() => buildHistoryPageAround(messages, "branch-a", "tool-1", "missing")).toThrow("目标记录");
    expect(() => buildHistoryPageAround(messages, "branch-a", "tool-1", "tool-1")).toThrow("可见文本");
    expect(() => buildHistoryPageAround(messages, "branch-a", "tool-1", "assistant-thinking")).toThrow("可见文本");
  });

  it("从页面末尾向后读取且不跨用户轮次边界", () => {
    const messages = Array.from({ length: 50 }, (_, index) => {
      const number = index + 1;
      return [
        { role: "user", content: `question-${number}`, __piEntryId: `user-${number}` },
        { role: "assistant", content: [{ type: "text", text: `answer-${number}` }], __piEntryId: `assistant-${number}` },
        { role: "toolResult", content: "result", __piEntryId: `tool-${number}` },
      ];
    }).flat();

    const middle = buildHistoryPageAfter(messages, "branch-a", "tool-50", "tool-20");
    expect(middle.history).toMatchObject({
      startEntryId: "user-21",
      endEntryId: "tool-40",
      hasMoreBefore: true,
      hasMoreAfter: true,
      turnCount: 20,
    });
    const end = buildHistoryPageAfter(messages, "branch-a", "tool-50", "tool-40");
    expect(end.history).toMatchObject({
      startEntryId: "user-41",
      endEntryId: "tool-50",
      hasMoreBefore: true,
      hasMoreAfter: false,
      turnCount: 10,
    });
  });

  it("到达根部时包含用户轮次前的兼容消息", () => {
    const messages = [
      { role: "assistant", __piEntryId: "legacy-1" },
      ...createBranchMessages(2),
    ];
    const page = buildLatestHistoryPage(messages, "branch-a", "assistant-2");
    expect(page.messages[0]).toMatchObject({ __piEntryId: "legacy-1" });
    expect(page.history).toMatchObject({ startEntryId: "user-1", hasMoreBefore: false, hasMoreAfter: false, turnCount: 2 });
  });

  it("空会话和无用户消息可以生成稳定空页", () => {
    expect(buildLatestHistoryPage([], "branch-a")).toEqual({
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
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
