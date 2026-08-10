// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ChatEvent, PiRuntimeGateway } from "../pi-runtime";
import type { WorkspaceFileService } from "../attachments";
import type { AgentReferenceResolver } from "../agent-references";
import { ChatApplicationService } from "./chat-service";
import { RuntimeSupervisor } from "../runtime/runtime-supervisor";

describe("ChatApplicationService", () => {
  it("订阅在关闭前持续持有同一个 RuntimeLease 并且关闭幂等", async () => {
    const release = vi.fn();
    const runtime = fakeRuntime();
    const supervisor = { acquire: vi.fn(async () => ({ runtime, generation: 1, retired: neverRetired(), release })) };
    const service = new ChatApplicationService({
      runtimeSupervisor: supervisor as never,
      sessionAgent: async () => "a1",
    });

    const subscription = await service.subscribe("s1", undefined);

    expect(release).not.toHaveBeenCalled();
    subscription.close();
    subscription.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it("Runtime 退休时结束旧订阅并释放租约，允许 EventSource 重连到新代", async () => {
    let retire: () => void = () => undefined;
    const retired = new Promise<void>((resolve) => { retire = resolve; });
    const release = vi.fn();
    const runtime = fakeRuntime();
    const service = new ChatApplicationService({
      runtimeSupervisor: { acquire: async () => ({ runtime, generation: 1, retired, release }) } as never,
      sessionAgent: async () => "a1",
    });
    const subscription = await service.subscribe("s1", undefined);
    const iterator = subscription.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "snapshot" });

    retire();

    await expect(iterator.next()).rejects.toMatchObject({ code: "RUNTIME_GENERATION_RETIRED" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("两个客户端在 Runtime 刷新后同时断开旧代，并可重连到同一个新代", async () => {
    const generations = [fakeRuntime(), fakeRuntime()];
    const createRuntime = vi.fn(async () => generations[createRuntime.mock.calls.length - 1]);
    const supervisor = new RuntimeSupervisor({
      modelRuntime: {} as ModelRuntime,
      resolveAgent: async () => ({ cwd: "/workspace/a1" }),
      createRuntime,
    });
    const service = new ChatApplicationService({ runtimeSupervisor: supervisor, sessionAgent: async () => "a1" });
    const [left, right] = await Promise.all([
      service.subscribe("s1", undefined),
      service.subscribe("s1", undefined),
    ]);
    const leftEvents = left.events[Symbol.asyncIterator]();
    const rightEvents = right.events[Symbol.asyncIterator]();

    await supervisor.refreshAgent("a1");

    await expect(leftEvents.next()).rejects.toMatchObject({ code: "RUNTIME_GENERATION_RETIRED" });
    await expect(rightEvents.next()).rejects.toMatchObject({ code: "RUNTIME_GENERATION_RETIRED" });
    const reconnected = await service.subscribe("s1", undefined);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect((await reconnected.events[Symbol.asyncIterator]().next()).value).toMatchObject({ type: "snapshot" });
    reconnected.close();
    await supervisor.drainAndDispose();
  });

  it("单个事件超过客户端队列总预算时直接断开而不保留载荷", async () => {
    const release = vi.fn();
    const runtime = fakeRuntime();
    runtime.subscribe = (_sessionId, _after, listener) => {
      listener?.({ id: 1, sessionId: "s1", runId: "r1", type: "text_delta", delta: "x".repeat(2 * 1024 * 1024) });
      return vi.fn();
    };
    const service = new ChatApplicationService({
      runtimeSupervisor: { acquire: async () => ({ runtime, generation: 1, retired: neverRetired(), release }) } as never,
      sessionAgent: async () => "a1",
    });
    const subscription = await service.subscribe("s1", undefined);

    await expect(subscription.events[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "CLIENT_TOO_SLOW" });
    subscription.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it("并发开始同一 Session Turn 时透传稳定 SESSION_BUSY", async () => {
    const runtime = fakeRuntime();
    let running = false;
    runtime.startPrompt = vi.fn(async (sessionId: string) => {
      if (running) throw Object.assign(new Error("busy"), { code: "SESSION_BUSY" });
      running = true;
      return { runId: "r1", sessionId, status: "running" as const, startedAt: "2026-08-07T00:00:00.000Z" };
    });
    const service = new ChatApplicationService({
      runtimeSupervisor: { acquire: async () => ({ runtime, generation: 1, retired: neverRetired(), release: vi.fn() }) } as never,
      sessionAgent: async () => "a1",
    });

    const results = await Promise.allSettled([
      service.startTurn("s1", { text: "A" }),
      service.startTurn("s1", { text: "B" }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "SESSION_BUSY")).toHaveLength(1);
  });

  it("在同一租约内重新授权附件与引用后启动消息，而不是误触发终止", async () => {
    const release = vi.fn();
    const runtime = fakeRuntime();
    runtime.listCommands = vi.fn(async () => [{ name: "review", description: "审阅", source: "extension" as const }]);
    const workspaceFiles = {
      resolve: vi.fn(async () => ({
        path: "attachments/design.png",
        name: "design.png",
        kind: "file",
      })),
    } as unknown as WorkspaceFileService;
    const referenceResolver = {
      resolve: vi.fn(async () => [{ type: "knowledge" as const, id: "kb-1", name: "真实资料" }]),
    } satisfies AgentReferenceResolver;
    const service = new ChatApplicationService({
      runtimeSupervisor: { acquire: async () => ({ runtime, generation: 1, retired: neverRetired(), release }) } as never,
      sessionAgent: async () => "a1",
      workspaceFiles,
      referenceResolver,
    });

    await service.startTurn("s1", {
      text: "/review 请分析",
      filePaths: ["attachments/design.png"],
      references: [{ type: "knowledge", id: "kb-1" }],
    });

    expect(runtime.abort).not.toHaveBeenCalled();
    expect(runtime.startPrompt).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining('<agent_references version="1" type="knowledge" id="kb-1" name="真实资料"/>'),
      "/review 请分析",
    );
    expect(runtime.startPrompt).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining('<agent_references version="1" type="file" path="attachments/design.png" kind="file"/>'),
      "/review 请分析",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("重新编辑只读取历史消息，不切换当前活跃分支", async () => {
    const runtime = fakeRuntime();
    const snapshot = { id: "s1", messages: [{ role: "user", content: "当前路径" }], lastEventId: 7 };
    runtime.openSession = vi.fn(async () => snapshot);
    runtime.readSessionMessage = vi.fn(async () => "历史问题");
    runtime.navigateTree = vi.fn(async () => ({ snapshot, editorText: "历史问题" }));
    const service = new ChatApplicationService({
      runtimeSupervisor: { acquire: async () => ({ runtime, generation: 1, retired: neverRetired(), release: vi.fn() }) } as never,
      sessionAgent: async () => "a1",
    });

    const result = await service.editHistory("s1", "user-old");

    expect(result.snapshot).toBe(snapshot);
    expect(result.draft.text).toBe("历史问题");
    expect(runtime.readSessionMessage).toHaveBeenCalledWith("s1", "user-old");
    expect(runtime.navigateTree).not.toHaveBeenCalled();
  });

  it("编辑后的实际发送先回退，再以新内容创建分支", async () => {
    const runtime = fakeRuntime();
    runtime.navigateTree = vi.fn(async () => ({ snapshot: { id: "s1", messages: [], lastEventId: 0 }, editorText: "旧问题" }));
    const service = new ChatApplicationService({
      runtimeSupervisor: { acquire: async () => ({ runtime, generation: 1, retired: neverRetired(), release: vi.fn() }) } as never,
      sessionAgent: async () => "a1",
    });

    await service.startBranchTurn("s1", "user-old", { text: "修改后的问题" });

    expect(runtime.navigateTree).toHaveBeenCalledWith("s1", "user-old");
    expect(runtime.startPrompt).toHaveBeenCalledWith("s1", "修改后的问题", "修改后的问题");
  });
});

function fakeRuntime(): PiRuntimeGateway {
  return {
    listModels: async () => [], listCommands: async () => [], listSessions: async () => [],
    createSession: async () => ({ id: "s1", messages: [], lastEventId: 0 }),
    openSession: async (id) => ({ id, messages: [], lastEventId: 0 }),
    startPrompt: vi.fn(async (sessionId: string) => ({ runId: "r1", sessionId, status: "running" as const, startedAt: "2026-08-07T00:00:00.000Z" })),
    prompt: async () => undefined, abort: vi.fn(async () => undefined), abortAll: async () => 0,
    setModel: async () => undefined, renameSession: async () => undefined, archiveSession: async () => undefined,
    unarchiveSession: async () => undefined, deleteSession: async () => undefined,
    discardUnassignedSession: async () => undefined,
    subscribe(sessionId, _after, listener) {
      listener?.({ type: "snapshot", id: 0, sessionId, messages: [], lastEventId: 0 } as ChatEvent);
      return vi.fn();
    },
    dispose: vi.fn(),
  };
}

function neverRetired(): Promise<void> {
  return new Promise<void>(() => undefined);
}
