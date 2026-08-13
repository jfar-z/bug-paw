// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ChatEvent, PiRuntimeGateway } from "../pi-runtime";
import { RuntimeSupervisor } from "./runtime-supervisor";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

class FakeRuntime implements PiRuntimeGateway {
  busy = false;
  drain?: () => Promise<void>;
  dispose = vi.fn();
  listModels = vi.fn(async () => []);
  listCommands = vi.fn(async () => []);
  listSessions = vi.fn(async () => []);
  createSession = vi.fn(async () => ({ id: "s1", messages: [], history: emptyHistory(), lastEventId: 0 }));
  openSession = vi.fn(async (id: string) => ({ id, messages: [], history: emptyHistory(), lastEventId: 0 }));
  startPrompt = vi.fn(async (sessionId: string) => ({ runId: "r1", sessionId, status: "running" as const, startedAt: new Date().toISOString() }));
  prompt = vi.fn(async () => undefined);
  abort = vi.fn(async () => undefined);
  abortAll = vi.fn(async () => this.busy ? 1 : 0);
  setModel = vi.fn(async () => undefined);
  renameSession = vi.fn(async () => undefined);
  archiveSession = vi.fn(async () => undefined);
  unarchiveSession = vi.fn(async () => undefined);
  deleteSession = vi.fn(async () => undefined);
  discardUnassignedSession = vi.fn(async () => undefined);
  subscribe(_id: string, _after: number | undefined | ((event: ChatEvent) => void), _listener?: (event: ChatEvent) => void) { return () => undefined; }
  isBusy() { return this.busy; }
}

function emptyHistory() {
  return { branchToken: "branch-test", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 };
}

describe("RuntimeSupervisor", () => {
  it("并发 acquire 共享一次创建并分别持有租约", async () => {
    const runtime = new FakeRuntime();
    const createRuntime = vi.fn(async () => runtime);
    const supervisor = createSupervisor(createRuntime);

    const [left, right] = await Promise.all([supervisor.acquire("a1"), supervisor.acquire("a1")]);

    expect(createRuntime).toHaveBeenCalledOnce();
    expect(left.runtime).toBe(right.runtime);
    expect(supervisor.activeLeaseCount).toBe(2);
    left.release();
    right.release();
  });

  it("刷新期间迟到的旧创建结果只被销毁且不会返回给调用方", async () => {
    const oldRuntime = new FakeRuntime();
    const newRuntime = new FakeRuntime();
    const oldFactory = deferred<PiRuntimeGateway>();
    const createRuntime = vi.fn().mockReturnValueOnce(oldFactory.promise).mockResolvedValueOnce(newRuntime);
    const supervisor = createSupervisor(createRuntime);

    const oldAcquire = supervisor.acquire("a1");
    await supervisor.refreshAgent("a1");
    oldFactory.resolve(oldRuntime);

    await expect(oldAcquire).rejects.toMatchObject({ code: "RUNTIME_GENERATION_RETIRED" });
    expect(oldRuntime.dispose).toHaveBeenCalledOnce();
    const lease = await supervisor.acquire("a1");
    expect(lease.runtime).toBe(newRuntime);
    lease.release();
  });

  it("活动租约释放前不销毁退休 Runtime", async () => {
    const runtime = new FakeRuntime();
    const supervisor = createSupervisor(vi.fn(async () => runtime));
    const lease = await supervisor.acquire("a1");

    await supervisor.refreshAgent("a1");
    expect(runtime.dispose).not.toHaveBeenCalled();
    lease.release();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("刷新时通知旧代租约并让订阅方主动重连", async () => {
    const runtime = new FakeRuntime();
    const supervisor = createSupervisor(vi.fn(async () => runtime));
    const lease = await supervisor.acquire("a1");

    await supervisor.refreshAgent("a1");

    await expect(lease.retired).resolves.toBeUndefined();
    lease.release();
  });

  it("删除 Agent 时等待迟到创建退出并保持墓碑直到持久化完成", async () => {
    const runtime = new FakeRuntime();
    const creation = deferred<PiRuntimeGateway>();
    const supervisor = createSupervisor(vi.fn(async () => creation.promise));
    const acquiring = supervisor.acquire("a1");

    const removing = supervisor.removeAgent("a1", 1_000);
    creation.resolve(runtime);

    await expect(acquiring).rejects.toMatchObject({ code: "RUNTIME_GENERATION_RETIRED" });
    await removing;
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(supervisor.trackedAgentCount).toBe(1);
    await expect(supervisor.acquire("a1")).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    supervisor.finalizeAgentRemoval("a1");
    expect(supervisor.trackedAgentCount).toBe(0);
  });

  it("删除 Agent 时阻止新租约并等待现有租约释放", async () => {
    const runtime = new FakeRuntime();
    const supervisor = createSupervisor(vi.fn(async () => runtime));
    const lease = await supervisor.acquire("a1");
    let removed = false;
    const removing = supervisor.removeAgent("a1", 1_000).then(() => { removed = true; });

    await expect(supervisor.acquire("a1")).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(removed).toBe(false);
    lease.release();
    await removing;
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("关闭后拒绝新租约并销毁关闭期间完成的迟到创建", async () => {
    const runtime = new FakeRuntime();
    const creation = deferred<PiRuntimeGateway>();
    const supervisor = createSupervisor(vi.fn(async () => creation.promise));
    const acquiring = supervisor.acquire("a1");
    const draining = supervisor.drainAndDispose(1_000);

    creation.resolve(runtime);

    await expect(acquiring).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    await draining;
    expect(runtime.dispose).toHaveBeenCalledOnce();
    await expect(supervisor.acquire("a1")).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });

  it("底层 abortAll 永久挂起时仍在关闭预算后强制释放 Runtime", async () => {
    const runtime = new FakeRuntime();
    runtime.busy = true;
    runtime.abortAll.mockImplementation(() => new Promise<0 | 1>(() => undefined));
    const supervisor = createSupervisor(vi.fn(async () => runtime));
    const lease = await supervisor.acquire("a1");
    lease.release();

    const startedAt = Date.now();
    await supervisor.drainAndDispose(30);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("关闭会等待 Runtime checkpoint drain 完成", async () => {
    const runtime = new FakeRuntime();
    const checkpoint = deferred<void>();
    runtime.drain = vi.fn(async () => checkpoint.promise);
    const supervisor = createSupervisor(vi.fn(async () => runtime));
    const lease = await supervisor.acquire("a1");
    lease.release();

    let closed = false;
    const closing = supervisor.drainAndDispose(1_000).then(() => { closed = true; });
    await vi.waitFor(() => expect(runtime.drain).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    checkpoint.resolve();
    await closing;
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("删除 Agent 到期时若租约未排空则拒绝提交删除", async () => {
    const runtime = new FakeRuntime();
    const supervisor = createSupervisor(vi.fn(async () => runtime));
    const lease = await supervisor.acquire("a1");

    await expect(supervisor.removeAgent("a1", 20)).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(runtime.dispose).not.toHaveBeenCalled();
    supervisor.restoreAgent("a1");
    lease.release();

    const nextLease = await supervisor.acquire("a1");
    nextLease.release();
  });
});

function createSupervisor(createRuntime: (context: unknown) => Promise<PiRuntimeGateway>) {
  return new RuntimeSupervisor({
    modelRuntime: {} as ModelRuntime,
    resolveAgent: async () => ({ cwd: "/workspace/a1" }),
    createRuntime,
  });
}
