import { describe, expect, it } from "vitest";

import type { AgentTurn, ConversationEntry, UserEntry } from "./conversation-timeline";
import { createPendingUserMessage, reconcilePendingUserMessage } from "./pending-user-message";

const user = (id: string, text: string, piEntryId?: string): UserEntry => ({
  id,
  type: "user",
  text,
  files: [],
  references: [],
  ...(piEntryId ? { piEntryId } : {}),
});

const agent = (id: string): AgentTurn => ({
  id,
  type: "agent",
  blocks: [],
});

describe("待确认用户消息协调", () => {
  it("快照尚未确认普通发送时把用户消息放在历史末尾", () => {
    const pendingEntry = user("pending-1", "新问题");
    const pending = createPendingUserMessage(
      "session-1",
      pendingEntry,
      [user("history-1", "旧问题"), agent("answer-1")],
    );

    const result = reconcilePendingUserMessage(
      "session-1",
      [user("history-1", "旧问题"), agent("answer-1")],
      pending,
    );

    expect(result.timeline.at(-1)).toBe(pendingEntry);
    expect(result.pending).toBe(pending);
  });

  it("权威快照包含本轮用户消息后清除待确认状态且不重复插入", () => {
    const pending = createPendingUserMessage("session-1", user("pending-1", "新问题"), []);
    const confirmed = [user("server-1", "新问题", "pi-user-1")];

    expect(reconcilePendingUserMessage("session-1", confirmed, pending))
      .toEqual({ timeline: confirmed, pending: undefined });
  });

  it("重新生成按目标用户消息之前的同文次数建立确认序位", () => {
    const entries: ConversationEntry[] = [
      user("same-1", "重复问题", "pi-user-1"),
      agent("answer-1"),
      user("same-2", "重复问题", "pi-user-2"),
      agent("answer-2"),
    ];
    const pending = createPendingUserMessage(
      "session-1",
      user("pending-2", "重复问题"),
      entries,
      "pi-user-2",
    );

    const beforeConfirmation = reconcilePendingUserMessage(
      "session-1",
      [user("same-1", "重复问题", "pi-user-1"), agent("answer-1")],
      pending,
    );
    expect(beforeConfirmation.timeline.filter((entry) => entry.type === "user")).toHaveLength(2);
    expect(beforeConfirmation.pending).toBe(pending);

    const confirmed = [
      user("same-1", "重复问题", "pi-user-1"),
      agent("answer-1"),
      user("same-branch", "重复问题", "pi-user-3"),
    ];
    expect(reconcilePendingUserMessage("session-1", confirmed, pending).pending).toBeUndefined();
  });

  it("附件路径不同不会误确认", () => {
    const pendingEntry = { ...user("pending", "查看附件"), files: [{ path: "attachments/new.png" }] };
    const pending = createPendingUserMessage("session-1", pendingEntry, []);
    const server = [{ ...user("server", "查看附件"), files: [{ path: "attachments/old.png" }] }];

    const result = reconcilePendingUserMessage("session-1", server, pending);

    expect(result.pending).toBe(pending);
    expect(result.timeline.at(-1)).toBe(pendingEntry);
  });

  it("引用身份不同不会误确认", () => {
    const pendingEntry = {
      ...user("pending", "执行工作流"),
      references: [{ type: "skill" as const, name: "review" }],
    };
    const pending = createPendingUserMessage("session-1", pendingEntry, []);
    const server = [{
      ...user("server", "执行工作流"),
      references: [{ type: "skill" as const, name: "deploy" }],
    }];

    expect(reconcilePendingUserMessage("session-1", server, pending).pending).toBe(pending);
  });

  it("其他会话不会补入当前待确认消息", () => {
    const pending = createPendingUserMessage("session-1", user("pending", "旧会话问题"), []);
    const nextSession = [user("server", "新会话问题")];

    expect(reconcilePendingUserMessage("session-2", nextSession, pending))
      .toEqual({ timeline: nextSession, pending });
  });
});
