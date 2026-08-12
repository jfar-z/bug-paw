import type { AgentReference } from "../shared/agent-reference-contracts";
import type { ConversationEntry, UserEntry } from "./conversation-timeline";

export interface PendingUserMessage {
  /**
   * 待确认消息所属会话，禁止跨会话补入。
   */
  sessionId: string;

  /**
   * 浏览器在权威快照确认前持续展示的用户消息。
   */
  entry: UserEntry;

  /**
   * 服务端时间线至少出现多少条同内容消息才算确认本轮。
   */
  requiredOccurrence: number;
}

export interface PendingUserMessageReconciliation {
  /**
   * 应交给消息窗口渲染的稳定时间线。
   */
  timeline: ConversationEntry[];

  /**
   * 尚未由服务端权威快照确认的消息状态。
   */
  pending?: PendingUserMessage;
}

/**
 * 根据发送位置创建待确认状态，同文消息使用出现序位避免误去重。
 */
export function createPendingUserMessage(
  sessionId: string,
  entry: UserEntry,
  timeline: ConversationEntry[],
  sourceEntryId?: string,
): PendingUserMessage {
  const sourceIndex = sourceEntryId
    ? timeline.findIndex((item) => item.type === "user" && item.piEntryId === sourceEntryId)
    : -1;
  const comparisonRange = sourceIndex >= 0 ? timeline.slice(0, sourceIndex) : timeline;
  return {
    sessionId,
    entry,
    requiredOccurrence: countMatchingUsers(comparisonRange, entry) + 1,
  };
}

/**
 * 用服务端快照确认待发送消息；尚未确认时将其稳定补在当前历史末尾。
 */
export function reconcilePendingUserMessage(
  sessionId: string,
  timeline: ConversationEntry[],
  pending: PendingUserMessage | undefined,
): PendingUserMessageReconciliation {
  if (!pending || pending.sessionId !== sessionId) {
    return { timeline, pending };
  }
  if (countMatchingUsers(timeline, pending.entry) >= pending.requiredOccurrence) {
    return { timeline, pending: undefined };
  }
  return { timeline: [...timeline, pending.entry], pending };
}

function countMatchingUsers(timeline: ConversationEntry[], expected: UserEntry): number {
  return timeline.filter((entry) => entry.type === "user" && sameUserContent(entry, expected)).length;
}

function sameUserContent(left: UserEntry, right: UserEntry): boolean {
  return left.text === right.text
    && sameOrderedValues(left.files.map((file) => file.path), right.files.map((file) => file.path))
    && sameOrderedValues(
      left.references.map(referenceIdentity),
      right.references.map(referenceIdentity),
    );
}

function sameOrderedValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function referenceIdentity(reference: AgentReference): string {
  if (reference.type === "skill") {
    return `skill:${reference.name}`;
  }
  if (reference.type === "knowledge") {
    return `knowledge:${reference.id}`;
  }
  return `file:${reference.path}:${reference.kind}`;
}
