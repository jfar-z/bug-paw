import { describe, expect, it } from "vitest";

import { isSessionHistoryPage, SESSION_HISTORY_TURNS_PER_PAGE } from "./session-history-contracts";

describe("会话历史分页契约", () => {
  it("只接受完整且页大小合法的历史元数据", () => {
    expect(isSessionHistoryPage({
      startEntryId: "user-21",
      endEntryId: "assistant-40",
      branchToken: "branch-a",
      branchLeafId: "assistant-100",
      hasMoreBefore: true,
      hasMoreAfter: false,
      turnCount: SESSION_HISTORY_TURNS_PER_PAGE,
    })).toBe(true);
    expect(isSessionHistoryPage({
      branchToken: "branch-a",
      hasMoreBefore: true,
      hasMoreAfter: false,
      turnCount: SESSION_HISTORY_TURNS_PER_PAGE + 1,
    })).toBe(false);
    expect(isSessionHistoryPage({ branchToken: "branch-a", hasMoreBefore: true, turnCount: 1 })).toBe(false);
  });
});
