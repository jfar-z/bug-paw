// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { SessionBulkPreparedPreview } from "../../shared/session-bulk-contracts";
import type { SessionBulkRepository } from "./session-bulk-repository";
import { createSessionBulkService } from "./session-bulk-service";

describe("SessionBulkService", () => {
  it("预览隐藏内部 Agent 归属信息", async () => {
    const prepared = preparedPreview();
    const service = createSessionBulkService({
      repository: repositoryDouble(prepared),
      acquireRuntime: vi.fn(),
    });

    const preview = await service.preview("delete", prepared.sessionIds);

    expect(preview).toEqual({
      action: "delete",
      sessionIds: prepared.sessionIds,
      sessionCount: 2,
      tasks: [],
      fingerprint: "fingerprint-1",
    });
    expect(preview).not.toHaveProperty("agentId");
  });

  it("归档不获取运行时且使用统一时间", async () => {
    const prepared = { ...preparedPreview(), action: "archive" as const };
    const repository = repositoryDouble(prepared);
    const acquireRuntime = vi.fn();
    const service = createSessionBulkService({
      repository,
      acquireRuntime,
      now: () => new Date("2026-08-11T01:02:03.000Z"),
    });

    await expect(service.execute({
      action: "archive",
      sessionIds: prepared.sessionIds,
      fingerprint: prepared.fingerprint,
    })).resolves.toEqual({ action: "archive", sessionCount: 2, affectedTaskCount: 0 });

    expect(repository.archive).toHaveBeenCalledWith(prepared, "2026-08-11T01:02:03.000Z");
    expect(acquireRuntime).not.toHaveBeenCalled();
  });

  it("确认指纹过期时拒绝执行", async () => {
    const prepared = preparedPreview();
    const repository = repositoryDouble(prepared);
    const service = createSessionBulkService({ repository, acquireRuntime: vi.fn() });

    await expect(service.execute({
      action: "delete",
      sessionIds: prepared.sessionIds,
      fingerprint: "old-fingerprint",
    })).rejects.toMatchObject({ code: "SESSION_BULK_PREVIEW_STALE" });

    expect(repository.deletePreservingTasks).not.toHaveBeenCalled();
  });

  it("后续会话暂存失败时回滚此前文件且不提交数据库", async () => {
    const preview = preparedPreview();
    const first = stagedDeletion();
    const repository = repositoryDouble(preview);
    const runtime = {
      prepareSessionDeletion: vi.fn(async (sessionId: string) => {
        if (sessionId === "session-2") throw new Error("stage unavailable");
        return first;
      }),
    };
    const release = vi.fn();
    const service = createSessionBulkService({
      repository,
      acquireRuntime: async () => ({ runtime, release }),
    });

    await expect(service.execute({
      action: "delete",
      sessionIds: preview.sessionIds,
      fingerprint: preview.fingerprint,
    })).rejects.toThrow("stage unavailable");

    expect(first.state).toBe("rolled-back");
    expect(repository.deletePreservingTasks).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("数据库事务失败时回滚所有已暂存文件", async () => {
    const preview = preparedPreview();
    const first = stagedDeletion();
    const second = stagedDeletion();
    const repository = repositoryDouble(preview);
    vi.mocked(repository.deletePreservingTasks).mockRejectedValueOnce(new Error("database unavailable"));
    const release = vi.fn();
    const service = createSessionBulkService({
      repository,
      acquireRuntime: async () => ({
        runtime: {
          prepareSessionDeletion: vi.fn(async (sessionId: string) => sessionId === "session-1" ? first : second),
        },
        release,
      }),
    });

    await expect(service.execute({
      action: "delete",
      sessionIds: preview.sessionIds,
      fingerprint: preview.fingerprint,
    })).rejects.toThrow("database unavailable");

    expect(first.state).toBe("rolled-back");
    expect(second.state).toBe("rolled-back");
    expect(release).toHaveBeenCalledOnce();
  });

  it("数据库提交后提交暂存文件并返回结果", async () => {
    const preview = preparedPreview();
    const first = stagedDeletion();
    const second = stagedDeletion();
    const repository = repositoryDouble(preview);
    const release = vi.fn();
    const service = createSessionBulkService({
      repository,
      acquireRuntime: async () => ({
        runtime: {
          prepareSessionDeletion: vi.fn(async (sessionId: string) => sessionId === "session-1" ? first : second),
        },
        release,
      }),
    });

    await expect(service.execute({
      action: "delete",
      sessionIds: preview.sessionIds,
      fingerprint: preview.fingerprint,
    })).resolves.toEqual({ action: "delete", sessionCount: 2, affectedTaskCount: 0 });

    expect(first.state).toBe("committed");
    expect(second.state).toBe("committed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("文件最终清理失败时记录错误但不回滚已提交数据库", async () => {
    const preview = preparedPreview();
    const deletion = stagedDeletion();
    deletion.commit = vi.fn(async () => { throw new Error("secret /private/path unavailable"); });
    const repository = repositoryDouble({ ...preview, sessionIds: ["session-1"], sessionCount: 1 });
    const onCleanupError = vi.fn();
    const service = createSessionBulkService({
      repository,
      acquireRuntime: async () => ({
        runtime: { prepareSessionDeletion: vi.fn(async () => deletion) },
        release: vi.fn(),
      }),
      onCleanupError,
    });

    await expect(service.execute({
      action: "delete",
      sessionIds: ["session-1"],
      fingerprint: preview.fingerprint,
    })).resolves.toMatchObject({ action: "delete", sessionCount: 1 });

    expect(onCleanupError).toHaveBeenCalledWith({
      sessionId: "session-1",
      message: expect.not.stringContaining("/private/path"),
    });
  });
});

function preparedPreview(): SessionBulkPreparedPreview {
  return {
    action: "delete",
    agentId: "agent-1",
    sessionIds: ["session-1", "session-2"],
    sessionCount: 2,
    tasks: [],
    fingerprint: "fingerprint-1",
  };
}

function repositoryDouble(preview: SessionBulkPreparedPreview): SessionBulkRepository {
  return {
    preview: vi.fn(async () => preview),
    archive: vi.fn(async () => ({ action: "archive" as const, sessionCount: preview.sessionCount, affectedTaskCount: 0 })),
    deletePreservingTasks: vi.fn(async () => ({ action: "delete" as const, sessionCount: preview.sessionCount, affectedTaskCount: 0 })),
  };
}

function stagedDeletion() {
  return {
    state: "staged" as "staged" | "committed" | "rolled-back",
    async commit() { this.state = "committed"; },
    async rollback() { this.state = "rolled-back"; },
  };
}
