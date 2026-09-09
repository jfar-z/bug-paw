import type { SessionSnapshot } from "./api";

/** 读取 Pi 写入的稳定 entry ID，浏览器派生 ID 不参与分页去重。 */
export function messageEntryId(message: unknown): string | undefined {
  return isRecord(message) && typeof message.__piEntryId === "string" ? message.__piEntryId : undefined;
}

/** 将更早页去重后前置到当前已加载消息。 */
export function mergeOlderHistory(currentMessages: readonly unknown[], pageMessages: readonly unknown[]): unknown[] {
  const currentIds = new Set(currentMessages.map(messageEntryId).filter((id): id is string => Boolean(id)));
  return [
    ...pageMessages.filter((message) => {
      const id = messageEntryId(message);
      return !id || !currentIds.has(id);
    }),
    ...currentMessages,
  ];
}

/** 将较新页去重后追加到当前聚焦历史。 */
export function mergeNewerHistory(currentMessages: readonly unknown[], pageMessages: readonly unknown[]): unknown[] {
  const currentIds = new Set(currentMessages.map(messageEntryId).filter((id): id is string => Boolean(id)));
  return [
    ...currentMessages,
    ...pageMessages.filter((message) => {
      const id = messageEntryId(message);
      return !id || !currentIds.has(id);
    }),
  ];
}

/** 用服务端刚提交的稳定轮次替换当前末尾，保留客户端已经分页加载的更早历史。 */
export function mergeCommittedTurn(currentMessages: readonly unknown[], turnMessages: readonly unknown[]): unknown[] {
  if (turnMessages.length === 0) return [...currentMessages];
  const firstEntryId = messageEntryId(turnMessages[0]);
  const currentTurnStart = firstEntryId
    ? currentMessages.findIndex((message) => messageEntryId(message) === firstEntryId)
    : -1;
  return currentTurnStart < 0
    ? [...currentMessages, ...turnMessages]
    : [...currentMessages.slice(0, currentTurnStart), ...turnMessages];
}

export function snapshotExtendsCurrentBranch(current: SessionSnapshot, next: SessionSnapshot): boolean {
  return Boolean(current.history && next.history)
    && current.id === next.id
    && current.history.branchToken === next.history.branchToken;
}

/** 同一分支保留已分页历史，token 变化时丢弃旧分支消息。 */
export function reconcileSnapshotMessages(
  current: SessionSnapshot | undefined,
  next: SessionSnapshot,
): { messages: unknown[]; reset: boolean } {
  if (!current || !snapshotExtendsCurrentBranch(current, next)) {
    return { messages: next.messages, reset: Boolean(current) };
  }
  const nextIds = new Set(next.messages.map(messageEntryId).filter((id): id is string => Boolean(id)));
  const stableHistory = current.messages.filter((message) => {
    const id = messageEntryId(message);
    return Boolean(id) && !nextIds.has(id!);
  });
  return { messages: [...stableHistory, ...next.messages], reset: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
