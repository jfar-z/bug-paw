// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { SessionRegistry } from "./session-registry";

describe("SessionRegistry", () => {
  it("并发打开同一 Session 只调用一次底层 open", async () => {
    const session = { id: "s1", dispose: vi.fn() };
    const open = vi.fn(async () => session);
    const registry = new SessionRegistry({ open, idOf: (value) => value.id });

    const [left, right] = await Promise.all([registry.open("s1"), registry.open("s1")]);

    expect(open).toHaveBeenCalledOnce();
    expect(left.session).toBe(right.session);
    left.release();
    right.release();
  });

  it("同一 Session 同时只接受一个 Turn", async () => {
    const registry = new SessionRegistry({ open: async (id: string) => ({ id, dispose: vi.fn() }), idOf: (value) => value.id });
    const handle = await registry.open("s1");
    const releaseTurn = handle.startTurn();

    expect(() => handle.startTurn()).toThrow(expect.objectContaining({ code: "SESSION_BUSY" }));
    releaseTurn();
    expect(() => handle.startTurn()).not.toThrow();
    handle.release();
  });

  it("达到上限时淘汰最久未使用的空闲 Session，但保留 SSE 固定项", async () => {
    const removed: string[] = [];
    const sessions = new Map<string, { id: string; dispose: ReturnType<typeof vi.fn> }>();
    const registry = new SessionRegistry({
      open: async (id: string) => {
        const session = { id, dispose: vi.fn() };
        sessions.set(id, session);
        return session;
      },
      idOf: (value) => value.id,
      maxSessions: 2,
      onRemove: (id) => removed.push(id),
    });
    await registry.open("s1");
    const pinned = await registry.open("s2");
    const releasePin = registry.retain("s2");

    await registry.open("s3");

    expect(removed).toEqual(["s1"]);
    expect(sessions.get("s1")?.dispose).toHaveBeenCalledOnce();
    expect(registry.peek("s2")).toBe(pinned.session);
    releasePin();
  });

  it("并发创建不同 Session 时也不会突破容量上限", async () => {
    let releaseOpen: (() => void) | undefined;
    const opening = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const open = vi.fn(async (id: string) => {
      await opening;
      return { id, dispose: vi.fn() };
    });
    const registry = new SessionRegistry({
      open,
      idOf: (value) => value.id,
      maxSessions: 1,
    });

    const first = registry.open("s1");
    const second = registry.open("s2");
    await Promise.resolve();
    releaseOpen?.();
    const results = await Promise.allSettled([first, second]);

    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "OPERATION_ABORTED" }),
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("Session 失效后销毁迟到 open 结果且回滚前拒绝重新打开", async () => {
    const dispose = vi.fn(() => undefined);
    let resolveOpen: (session: { id: string; dispose(): void }) => void = () => undefined;
    const opening = new Promise<{ id: string; dispose(): void }>((resolve) => { resolveOpen = resolve; });
    const registry = new SessionRegistry<{ id: string; dispose(): void }>({ open: () => opening, idOf: (value) => value.id });
    const pending = registry.open("s1");
    const late = { id: "s1", dispose };

    registry.invalidate("s1");
    resolveOpen(late);

    await expect(pending).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(dispose).toHaveBeenCalledOnce();
    await expect(registry.open("s1")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await registry.restore("s1");
  });

  it("高频删除提交后不保留历史墓碑与版本", async () => {
    const registry = new SessionRegistry({ open: async (id: string) => ({ id, dispose: vi.fn() }), idOf: (value) => value.id });

    for (let index = 0; index < 1_000; index += 1) {
      const sessionId = `s-${index}`;
      await registry.open(sessionId);
      registry.invalidate(sessionId);
      await registry.finalizeDeletion(sessionId);
    }

    expect(registry.trackedDeletionCount).toBe(0);
  });

  it("Registry dispose 后销毁所有迟到 open 结果", async () => {
    const dispose = vi.fn(() => undefined);
    let resolveOpen: (session: { id: string; dispose(): void }) => void = () => undefined;
    const opening = new Promise<{ id: string; dispose(): void }>((resolve) => { resolveOpen = resolve; });
    const registry = new SessionRegistry<{ id: string; dispose(): void }>({ open: () => opening, idOf: (value) => value.id });
    const pending = registry.open("s1");
    const late = { id: "s1", dispose };

    registry.dispose();
    resolveOpen(late);

    await expect(pending).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
