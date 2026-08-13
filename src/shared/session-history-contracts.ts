import { Type, type Static } from "typebox";

export const SESSION_HISTORY_TURNS_PER_PAGE = 20;

export const SessionHistoryPageSchema = Type.Object({
  startEntryId: Type.Optional(Type.String({ minLength: 1 })),
  endEntryId: Type.Optional(Type.String({ minLength: 1 })),
  branchToken: Type.String({ minLength: 1 }),
  branchLeafId: Type.Optional(Type.String({ minLength: 1 })),
  hasMoreBefore: Type.Boolean(),
  hasMoreAfter: Type.Boolean(),
  turnCount: Type.Integer({ minimum: 0, maximum: SESSION_HISTORY_TURNS_PER_PAGE }),
}, { additionalProperties: false });

export interface SessionHistoryResult {
  sessionId: string;
  messages: unknown[];
  history: SessionHistoryPage;
  targetEntryId?: string;
}

export type SessionHistoryPage = Static<typeof SessionHistoryPageSchema>;

/** 浏览器和服务端共用的轻量历史页元数据校验。 */
export function isSessionHistoryPage(value: unknown): value is SessionHistoryPage {
  if (!isRecord(value)) return false;
  return optionalNonEmptyString(value.startEntryId)
    && optionalNonEmptyString(value.endEntryId)
    && typeof value.branchToken === "string"
    && value.branchToken.length > 0
    && optionalNonEmptyString(value.branchLeafId)
    && typeof value.hasMoreBefore === "boolean"
    && typeof value.hasMoreAfter === "boolean"
    && Number.isSafeInteger(value.turnCount)
    && Number(value.turnCount) >= 0
    && Number(value.turnCount) <= SESSION_HISTORY_TURNS_PER_PAGE;
}

function optionalNonEmptyString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
