// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { SessionBulkPreparedPreview } from "../../shared/session-bulk-contracts";
import type { SessionBulkRepository } from "./session-bulk-repository";
import { createSessionBulkService } from "./session-bulk-service";

describe("SessionBulkService", () => {
  it("预览隐藏内部 Agent 归属和解析后的会话 ID", async () => {
    const prepared = preparedPreview();
    const service = createSessionBulkService({
      repository: repositoryDouble(prepared),
      acquireRuntime: vi.fn(),
    });

    const preview = await service.preview("delete", prepared.target);

    expect(preview).toEqual({
      action: "delete",
      target: prepared.target,
      sessionCount: 2,
      tasks: [],
      fingerprint: "fingerprint-1",
    });
    expect(preview).not.toHaveProperty("agentId");
    expect(preview).not.toHaveProperty("resolvedSessionIds");
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
      target: prepared.target,
      fingerprint: prepared.fingerprint,
    })).resolves.toEqual({ action: "archive", sessionCount: 2, affectedTaskCount: 0 });

    expect(repository.archive).toHaveBeenCalledWith(prepared, "2026-08-11T01:02:03.000Z");
    expect(acquireRuntime).not.toHaveBeenCalled();
  });

  it("全部恢复重新解析同一目标且不获取运行时", async () => {
    const target = { mode: "all_archived" as const, agentId: "agent-1" };
    const prepared = { ...preparedPreview(), action: "restore" as const, target };
    const repository = repositoryDouble(prepared);
    const acquireRuntime = vi.fn();
    const service = createSessionBulkService({
      repository,
      acquireRuntime,
      now: () => new Date("2026-08-11T01:02:03.000Z"),
    });

    await expect(service.execute({
      action: "restore",
      target,
      fingerprint: prepared.fingerprint,
    })).resolves.toEqual({ action: "restore", sessionCount: 2, affectedTaskCount: 0 });

    expect(repository.preview).toHaveBeenCalledWith("restore", target);
    expect(repository.restore).toHaveBeenCalledWith(prepared, "2026-08-11T01:02:03.000Z");
    expect(acquireRuntime).not.toHaveBeenCalled();
  });

  it("确认指纹过期时拒绝执行", async () => {
    const prepared = preparedPreview();
    const repository = repositoryDouble(prepared);
    const service = createSessionBulkService({ repository, acquireRuntime: vi.fn() });

    await expect(service.execute({
      action: "delete",
      target: prepared.target,
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
      target: preview.target,
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
      target: preview.target,
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
      target: preview.target,
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
    const singlePreview: SessionBulkPreparedPreview = {
      ...preview,
      target: { mode: "selected", sessionIds: ["session-1"] },
      resolvedSessionIds: ["session-1"],
      sessionCount: 1,
    };
    const repository = repositoryDouble(singlePreview);
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
      target: singlePreview.target,
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
    target: { mode: "selected", sessionIds: ["session-1", "session-2"] },
    resolvedSessionIds: ["session-1", "session-2"],
    sessionCount: 2,
    tasks: [],
    fingerprint: "fingerprint-1",
  };
}

function repositoryDouble(preview: SessionBulkPreparedPreview): SessionBulkRepository {
  return {
    preview: vi.fn(async () => preview),
    archive: vi.fn(async () => ({ action: "archive" as const, sessionCount: preview.sessionCount, affectedTaskCount: 0 })),
    restore: vi.fn(async () => ({ action: "restore" as const, sessionCount: preview.sessionCount, affectedTaskCount: 0 })),
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
