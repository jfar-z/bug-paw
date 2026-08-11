import type { SessionHistoryPage } from "../../shared/session-history-contracts";
import { SESSION_HISTORY_TURNS_PER_PAGE } from "../../shared/session-history-contracts";

export interface SessionHistorySlice {
  messages: unknown[];
  history: SessionHistoryPage;
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
    return createSlice(messages, branchToken, branchLeafId, 0, false, undefined);
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
