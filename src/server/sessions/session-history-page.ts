import type { SessionHistoryPage } from "../../shared/session-history-contracts";
import { SESSION_HISTORY_TURNS_PER_PAGE } from "../../shared/session-history-contracts";
import { extractVisibleSessionText } from "../../shared/session-text-search";

export interface SessionHistorySlice {
  messages: unknown[];
  history: SessionHistoryPage;
  targetEntryId?: string;
}

interface UserTurn {
  start: number;
  end: number;
  entryId: string;
}

/** 返回当前活动分支最后二十个完整用户轮次。 */
export function buildLatestHistoryPage(
  messages: readonly unknown[],
  branchToken: string,
  branchLeafId?: string,
): SessionHistorySlice {
  const turns = collectUserTurns(messages);
  if (turns.length === 0) {
    return createSlice(messages, branchToken, branchLeafId, 0, false, undefined, false);
  }
  const firstTurn = Math.max(0, turns.length - SESSION_HISTORY_TURNS_PER_PAGE);
  const start = firstTurn === 0 ? 0 : turns[firstTurn].start;
  return createSlice(
    messages.slice(start),
    branchToken,
    branchLeafId,
    turns.length - firstTurn,
    firstTurn > 0,
    turns[firstTurn].entryId,
    false,
  );
}

/** 返回指定用户轮次起点之前的一页，绝不从 assistant 或 toolResult 中间切开。 */
export function buildHistoryPageBefore(
  messages: readonly unknown[],
  branchToken: string,
  branchLeafId: string | undefined,
  before: string,
): SessionHistorySlice {
  const turns = collectUserTurns(messages);
  const beforeMessage = messages.find((message) => entryIdOf(message) === before);
  if (!beforeMessage) throw new Error("历史游标不存在");
  const beforeTurn = turns.findIndex((turn) => turn.entryId === before);
  if (beforeTurn < 0) throw new Error("历史游标必须是用户轮次起点");
  const firstTurn = Math.max(0, beforeTurn - SESSION_HISTORY_TURNS_PER_PAGE);
  const pageMessages = beforeTurn === 0
    ? []
    : messages.slice(firstTurn === 0 ? 0 : turns[firstTurn].start, turns[beforeTurn].start);
  return createSlice(
    pageMessages,
    branchToken,
    branchLeafId,
    beforeTurn - firstTurn,
    firstTurn > 0,
    turns[firstTurn]?.entryId,
    true,
  );
}

/** 返回包含目标文本消息的历史窗口。 */
export function buildHistoryPageAround(
  messages: readonly unknown[],
  branchToken: string,
  branchLeafId: string | undefined,
  anchorEntryId: string,
): SessionHistorySlice {
  const turns = collectUserTurns(messages);
  const anchorIndex = messages.findIndex((message) => entryIdOf(message) === anchorEntryId);
  if (anchorIndex < 0) throw new Error("目标记录不存在");
  if (!extractVisibleSessionText(messages[anchorIndex])) throw new Error("目标记录不是可见文本消息");
  const anchorTurn = turns.findIndex(({ start, end }) => anchorIndex >= start && anchorIndex < end);
  if (anchorTurn < 0) throw new Error("目标记录不属于用户轮次中的可见文本消息");

  let firstTurn = Math.max(0, anchorTurn - Math.floor(SESSION_HISTORY_TURNS_PER_PAGE / 2));
  const lastTurn = Math.min(turns.length, firstTurn + SESSION_HISTORY_TURNS_PER_PAGE);
  firstTurn = Math.max(0, lastTurn - SESSION_HISTORY_TURNS_PER_PAGE);
  const start = firstTurn === 0 ? 0 : turns[firstTurn]!.start;
  const end = lastTurn === turns.length ? messages.length : turns[lastTurn]!.start;
  return {
    ...createSlice(
      messages.slice(start, end),
      branchToken,
      branchLeafId,
      lastTurn - firstTurn,
      firstTurn > 0,
      turns[firstTurn]?.entryId,
      lastTurn < turns.length,
    ),
    targetEntryId: anchorEntryId,
  };
}

/** 返回指定页面末尾之后的下一页完整用户轮次。 */
export function buildHistoryPageAfter(
  messages: readonly unknown[],
  branchToken: string,
  branchLeafId: string | undefined,
  after: string,
): SessionHistorySlice {
  const afterIndex = messages.findIndex((message) => entryIdOf(message) === after);
  if (afterIndex < 0) throw new Error("历史游标不存在");
  const turns = collectUserTurns(messages);
  const firstTurn = turns.findIndex(({ start }) => start > afterIndex);
  if (firstTurn < 0) {
    return createSlice([], branchToken, branchLeafId, 0, turns.length > 0, undefined, false);
  }
  const lastTurn = Math.min(turns.length, firstTurn + SESSION_HISTORY_TURNS_PER_PAGE);
  const start = firstTurn === 0 ? 0 : turns[firstTurn]!.start;
  const end = lastTurn === turns.length ? messages.length : turns[lastTurn]!.start;
  return createSlice(
    messages.slice(start, end),
    branchToken,
    branchLeafId,
    lastTurn - firstTurn,
    firstTurn > 0,
    turns[firstTurn]?.entryId,
    lastTurn < turns.length,
  );
}

function collectUserTurns(messages: readonly unknown[]): UserTurn[] {
  const starts = messages.flatMap((message, index) => {
    const entryId = entryIdOf(message);
    return roleOf(message) === "user" && entryId ? [{ start: index, entryId }] : [];
  });
  return starts.map((turn, index) => ({
    ...turn,
    end: starts[index + 1]?.start ?? messages.length,
  }));
}

function createSlice(
  messages: readonly unknown[],
  branchToken: string,
  branchLeafId: string | undefined,
  turnCount: number,
  hasMoreBefore: boolean,
  startEntryId: string | undefined,
  hasMoreAfter: boolean,
): SessionHistorySlice {
  const endEntryId = [...messages].reverse().map(entryIdOf).find((value): value is string => value !== undefined);
  return {
    messages: [...messages],
    history: {
      ...(startEntryId ? { startEntryId } : {}),
      ...(endEntryId ? { endEntryId } : {}),
      branchToken,
      ...(branchLeafId ? { branchLeafId } : {}),
      hasMoreBefore,
      hasMoreAfter,
      turnCount,
    },
  };
}

function roleOf(value: unknown): unknown {
  return isRecord(value) ? value.role : undefined;
}

function entryIdOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.__piEntryId === "string" ? value.__piEntryId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
