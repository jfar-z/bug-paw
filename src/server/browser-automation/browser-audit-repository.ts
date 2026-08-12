import type { Database } from "../database/database";

/** 审计记录关联的产物摘要。 */
export interface BrowserAuditArtifact {
  /** Agent 工作区相对路径。 */
  path: string;
  /** 文件 MIME。 */
  mediaType: string;
  /** 文件字节数。 */
  size: number;
  /** 文件 SHA-256。 */
  sha256: string;
}

/** 不包含正文、输入和凭证的浏览器审计事件。 */
export interface BrowserAuditEvent {
  id: string;
  createdAt: string;
  agentId: string;
  sessionId: string;
  runId: string;
  toolName: string;
  operation: string;
  origin?: string;
  finalOrigin?: string;
  decision: "allowed" | "blocked" | "failed";
  errorCode?: string;
  queueWaitMs?: number;
  artifact?: BrowserAuditArtifact;
}

interface BrowserAuditRow extends Record<string, unknown> {
  id: string;
  created_at: string;
  agent_id: string;
  session_id: string;
  run_id: string;
  tool_name: string;
  operation: string;
  origin: string | null;
  final_origin: string | null;
  decision: BrowserAuditEvent["decision"];
  error_code: string | null;
  queue_wait_ms: number | null;
  artifact_path: string | null;
  artifact_mime: string | null;
  artifact_bytes: number | null;
  artifact_sha256: string | null;
}

/** 浏览器最小审计数据的 SQLite Repository。 */
export class BrowserAuditRepository {
  /** 创建审计 Repository。 */
  constructor(private readonly database: Database) {}

  /** 写入一条已净化的浏览器审计事件。 */
  record(event: BrowserAuditEvent): void {
    this.database.write(`
      INSERT INTO browser_audit_events(
        id, created_at, agent_id, session_id, run_id, tool_name, operation,
        origin, final_origin, decision, error_code, queue_wait_ms,
        artifact_path, artifact_mime, artifact_bytes, artifact_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      event.id,
      event.createdAt,
      event.agentId,
      event.sessionId,
      event.runId,
      event.toolName,
      event.operation,
      event.origin ?? null,
      event.finalOrigin ?? null,
      event.decision,
      event.errorCode ?? null,
      event.queueWaitMs ?? null,
      event.artifact?.path ?? null,
      event.artifact?.mediaType ?? null,
      event.artifact?.size ?? null,
      event.artifact?.sha256 ?? null,
    ]);
  }

  /** 按时间倒序读取有界审计事件。 */
  list(limit: number): BrowserAuditEvent[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.database.read<BrowserAuditRow>(`
      SELECT * FROM browser_audit_events ORDER BY created_at DESC LIMIT ?
    `, [boundedLimit]).map(toEvent);
  }

  /** 删除早于截止时间的事件并返回数量。 */
  prune(cutoff: string): number {
    return this.database.write("DELETE FROM browser_audit_events WHERE created_at < ?", [cutoff]).changes;
  }
}

/** 把数据库 snake_case 行转换为公开事件。 */
function toEvent(row: BrowserAuditRow): BrowserAuditEvent {
  const artifact = row.artifact_path && row.artifact_mime && row.artifact_bytes !== null && row.artifact_sha256
    ? { path: row.artifact_path, mediaType: row.artifact_mime, size: row.artifact_bytes, sha256: row.artifact_sha256 }
    : undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    agentId: row.agent_id,
    sessionId: row.session_id,
    runId: row.run_id,
    toolName: row.tool_name,
    operation: row.operation,
    ...(row.origin ? { origin: row.origin } : {}),
    ...(row.final_origin ? { finalOrigin: row.final_origin } : {}),
    decision: row.decision,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.queue_wait_ms !== null ? { queueWaitMs: row.queue_wait_ms } : {}),
    ...(artifact ? { artifact } : {}),
  };
}
