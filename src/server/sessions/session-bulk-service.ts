import type { PiRuntimeGateway, StagedSessionDeletion } from "../pi-runtime";
import type {
  SessionBulkAction,
  SessionBulkPreview,
  SessionBulkResult,
  SessionBulkTarget,
} from "../../shared/session-bulk-contracts";
import { DomainError, toSafePublicMessage } from "../core/errors";
import type { SessionBulkRepository } from "./session-bulk-repository";

interface SessionBulkRuntimeLease {
  runtime: Pick<PiRuntimeGateway, "prepareSessionDeletion">;
  release(): void;
}

interface SessionBulkServiceOptions {
  repository: SessionBulkRepository;
  acquireRuntime(agentId: string): Promise<SessionBulkRuntimeLease>;
  now?: () => Date;
  onCleanupError?(error: { sessionId: string; message: string }): void;
}

interface ExecuteSessionBulkInput {
  action: SessionBulkAction;
  target: SessionBulkTarget;
  fingerprint: string;
}

/** 会话批量应用服务公开边界。 */
export interface SessionBulkService {
  preview(action: SessionBulkAction, target: SessionBulkTarget): Promise<SessionBulkPreview>;
  execute(input: ExecuteSessionBulkInput): Promise<SessionBulkResult>;
}

/** 协调批量会话预览、运行时文件暂存与数据库事务。 */
export function createSessionBulkService(options: SessionBulkServiceOptions): SessionBulkService {
  const now = options.now ?? (() => new Date());

  /** 返回不包含内部 Agent 归属信息的确认预览。 */
  async function preview(action: SessionBulkAction, target: SessionBulkTarget): Promise<SessionBulkPreview> {
    const {
      agentId: _agentId,
      resolvedSessionIds: _resolvedSessionIds,
      ...publicPreview
    } = await options.repository.preview(action, target);
    return publicPreview;
  }

  /** 执行用户已用指纹确认的批量操作。 */
  async function execute(input: ExecuteSessionBulkInput): Promise<SessionBulkResult> {
    const prepared = await options.repository.preview(input.action, input.target);
    if (prepared.fingerprint !== input.fingerprint) {
      throw new DomainError("SESSION_BULK_PREVIEW_STALE", "会话或定时任务已发生变化，请重新确认");
    }
    const timestamp = now().toISOString();
    if (input.action === "archive") {
      return options.repository.archive(prepared, timestamp);
    }
    if (input.action === "restore") {
      return options.repository.restore(prepared, timestamp);
    }

    const lease = await options.acquireRuntime(prepared.agentId);
    const staged: Array<{ sessionId: string; deletion: StagedSessionDeletion }> = [];
    try {
      if (!lease.runtime.prepareSessionDeletion) {
        throw new DomainError("OPERATION_ABORTED", "当前运行时不支持安全删除会话");
      }
      try {
        for (const sessionId of prepared.resolvedSessionIds) {
          const deletion = await lease.runtime.prepareSessionDeletion(sessionId);
          staged.push({ sessionId, deletion });
        }
      } catch (error) {
        await rollbackAll(staged);
        throw error;
      }

      let result: SessionBulkResult;
      try {
        result = await options.repository.deletePreservingTasks(prepared, timestamp);
      } catch (error) {
        await rollbackAll(staged);
        throw error;
      }

      const cleanupResults = await Promise.allSettled(staged.map(({ deletion }) => deletion.commit()));
      cleanupResults.forEach((resultItem, index) => {
        if (resultItem.status !== "rejected") return;
        options.onCleanupError?.({
          sessionId: staged[index]!.sessionId,
          message: toSafePublicMessage(resultItem.reason, "会话文件清理失败"),
        });
      });
      return result;
    } finally {
      lease.release();
    }
  }

  return { preview, execute };
}

/** 尽力恢复所有已暂存文件，保留最初的业务错误。 */
async function rollbackAll(staged: Array<{ deletion: StagedSessionDeletion }>): Promise<void> {
  await Promise.allSettled(staged.map(({ deletion }) => deletion.rollback()));
}
