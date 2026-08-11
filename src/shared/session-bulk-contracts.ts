/** 会话批量操作类型。 */
export type SessionBulkAction = "archive" | "restore" | "delete";

/** 会话批量操作的客户端目标范围。 */
export type SessionBulkTarget =
  | { mode: "selected"; sessionIds: string[] }
  | { mode: "all_archived"; agentId: string };

/** 批量操作预览中的定时任务摘要。 */
export interface SessionBulkTaskSummary {
  id: string;
  name: string;
  sessionId: string;
}

/** 用户确认批量操作前读取的稳定预览。 */
export interface SessionBulkPreview {
  action: SessionBulkAction;
  target: SessionBulkTarget;
  sessionCount: number;
  tasks: SessionBulkTaskSummary[];
  fingerprint: string;
}

/** 服务端执行批量操作时使用的带归属预览。 */
export interface SessionBulkPreparedPreview extends SessionBulkPreview {
  agentId: string;
  resolvedSessionIds: string[];
}

/** 会话批量操作结果。 */
export interface SessionBulkResult {
  action: SessionBulkAction;
  sessionCount: number;
  affectedTaskCount: number;
}
