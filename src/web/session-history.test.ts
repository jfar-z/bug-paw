import { describe, expect, it } from "vitest";

import type { SessionSnapshot } from "./api";
import { mergeOlderHistory, reconcileSnapshotMessages } from "./session-history";

const messages = (...ids: string[]) => ids.map((id) => ({ role: id.startsWith("user") ? "user" : "assistant", __piEntryId: id }));
const entryIds = (items: unknown[]) => items.map((item) => (item as { __piEntryId?: string }).__piEntryId);
const snapshot = (ids: string[], branchToken: string): SessionSnapshot => ({
  id: "session-1",
  messages: messages(...ids),
  history: { branchToken, hasMoreBefore: true, turnCount: 20 },
  lastEventId: 0,
});

describe("浏览器会话历史合并", () => {
  it("更早页按 entry ID 去重前置", () => {
    expect(entryIds(mergeOlderHistory(
      messages("user-21", "assistant-40"),
      messages("user-1", "assistant-20", "user-21"),
    ))).toEqual(["user-1", "assistant-20", "user-21", "assistant-40"]);
  });

  it("同分支权威快照保留已加载历史", () => {
    const reconciled = reconcileSnapshotMessages(
      snapshot(["user-1", "old-leaf"], "branch-a"),
      snapshot(["old-leaf", "user-new", "new-leaf"], "branch-a"),
    );
    expect(reconciled.reset).toBe(false);
    expect(entryIds(reconciled.messages)).toEqual(["user-1", "old-leaf", "user-new", "new-leaf"]);
  });

  it("分支标识变化时重置到新分支最近页", () => {
    const next = snapshot(["user-shared", "new-leaf"], "branch-b");
    expect(reconcileSnapshotMessages(snapshot(["user-old", "old-leaf"], "branch-a"), next))
      .toEqual({ reset: true, messages: next.messages });
  });

  it("没有稳定 ID 的临时消息只保留最新版本", () => {
    const current = snapshot(["user-1"], "branch-a");
    current.messages.push({ role: "assistant", content: "partial" });
    const next = snapshot(["user-1"], "branch-a");
    next.messages.push({ role: "assistant", content: "new partial" });
    expect(reconcileSnapshotMessages(current, next).messages.at(-1)).toMatchObject({ content: "new partial" });
  });
});
