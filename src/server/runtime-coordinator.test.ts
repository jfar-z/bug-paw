// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createRuntimeCoordinator } from "./runtime-coordinator";

const modelA = { provider: "provider-2", id: "model-a", name: "模型 A" };
const modelB = { provider: "provider-2", id: "model-b", name: "模型 B" };

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function successfulMessage(text = "OK") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  };
}

function createRuntime(models = [modelA, modelB]) {
  return {
    getProvider: vi.fn((providerId: string) => providerId === "provider-2" ? { id: providerId } : undefined),
    getModels: vi.fn((providerId: string) => providerId === "provider-2" ? models : []),
    getAvailable: vi.fn(async () => models),
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    completeSimple: vi.fn(async () => successfulMessage()),
  } as unknown as ModelRuntime;
}

function createManager() {
  return {
    refreshModels: vi.fn(),
    replaceModelRuntime: vi.fn(async () => undefined),
    refreshAgent: vi.fn(async () => undefined),
    refreshAllAgents: vi.fn(async () => undefined),
    abortAll: vi.fn(async () => 0),
    removeAgent: vi.fn(async () => undefined),
    finalizeAgentRemoval: vi.fn(),
    restoreAgent: vi.fn(),
    drainAndDispose: vi.fn(async () => undefined),
  };
}

describe("RuntimeCoordinator", () => {
  it("刷新 Pi 配置时重建模型运行时，确保 Provider 改名后的模型重新注册", async () => {
    const initialRuntime = createRuntime([modelA]);
    const rebuiltRuntime = createRuntime([modelB]);
    const manager = {
      ...createManager(),
      replaceModelRuntime: vi.fn(async () => undefined),
    };
    const recreateModelRuntime = vi.fn(async () => rebuiltRuntime);
    const coordinator = createRuntimeCoordinator({
      modelRuntime: initialRuntime,
      runtimeSupervisor: manager,
      recreateModelRuntime,
    } as never);

    await coordinator.refreshRuntime();

    expect(recreateModelRuntime).toHaveBeenCalledOnce();
    expect(manager.replaceModelRuntime).toHaveBeenCalledWith(rebuiltRuntime);
    await expect(coordinator.listModels()).resolves.toEqual([modelB]);
    await coordinator.testModels("provider-2", { scope: "current", modelId: "model-b" });
    expect(rebuiltRuntime.completeSimple).toHaveBeenCalledOnce();
    expect(initialRuntime.completeSimple).not.toHaveBeenCalled();
  });

  it("全局刷新先中断、再刷新模型、最后失效 Agent Runtime", async () => {
    const calls: string[] = [];
    const runtime = createRuntime();
    const manager = createManager();
    (runtime.refresh as ReturnType<typeof vi.fn>).mockImplementation(async () => { calls.push("models"); });
    (manager.abortAll as ReturnType<typeof vi.fn>).mockImplementation(async () => { calls.push("abort"); return 2; });
    (manager.refreshAllAgents as ReturnType<typeof vi.fn>).mockImplementation(async () => { calls.push("invalidate"); });

    await expect(createRuntimeCoordinator({ modelRuntime: runtime, runtimeSupervisor: manager }).refreshRuntime()).resolves.toEqual({ abortedSessions: 2 });
    expect(calls).toEqual(["abort", "models", "invalidate"]);
  });

  it("全局刷新进行中拒绝重复请求", async () => {
    const deferred = createDeferred<void>();
    const runtime = createRuntime();
    const manager = createManager();
    (runtime.refresh as ReturnType<typeof vi.fn>).mockReturnValue(deferred.promise);
    const coordinator = createRuntimeCoordinator({ modelRuntime: runtime, runtimeSupervisor: manager });

    const first = coordinator.refreshRuntime();
    await expect(coordinator.refreshRuntime()).rejects.toMatchObject({ code: "REFRESH_IN_PROGRESS" });
    deferred.resolve();
    await first;
  });

  it("返回 Pi 的连接失败详情但隐藏凭证", async () => {
    const runtime = createRuntime([modelA]);
    (runtime.completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...successfulMessage(),
      stopReason: "error",
      errorMessage: "HTTP 401: Bearer secret-token-invalid",
    });
    const coordinator = createRuntimeCoordinator({ modelRuntime: runtime, runtimeSupervisor: createManager() });

    const result = await coordinator.testModels("provider-2", { scope: "current", modelId: "model-a" });

    expect(result.results[0]).toMatchObject({ ok: false, message: "模型请求失败" });
    expect(result.results[0].message).not.toContain("secret-token-invalid");
  });

  it("测试当前模型时向共享运行时发送最小真实请求", async () => {
    const runtime = createRuntime();
    const coordinator = createRuntimeCoordinator({ modelRuntime: runtime, runtimeSupervisor: createManager() });

    const result = await coordinator.testModels("provider-2", { scope: "current", modelId: "model-b" });

    expect(runtime.refresh).toHaveBeenCalledWith({ allowNetwork: false });
    expect(runtime.completeSimple).toHaveBeenCalledTimes(1);
    expect(runtime.completeSimple).toHaveBeenCalledWith(modelB, {
      messages: [expect.objectContaining({ role: "user", content: "只回复 OK" })],
    }, expect.objectContaining({ reasoning: "off", maxTokens: 8, maxRetries: 0, timeoutMs: 20_000 }));
    expect(result).toMatchObject({
      providerId: "provider-2",
      results: [{ modelId: "model-b", modelName: "模型 B", ok: true, responsePreview: "OK" }],
    });
  });

  it("清洗恶意 Provider 在成功响应中回显的凭证", async () => {
    const runtime = createRuntime([modelA]);
    (runtime.completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(successfulMessage(
      "Basic dXNlcjpwYXNz https://user:password@example.test?api_key=secret-value",
    ));
    const coordinator = createRuntimeCoordinator({ modelRuntime: runtime, runtimeSupervisor: createManager() });

    const result = await coordinator.testModels("provider-2", { scope: "current", modelId: "model-a" });

    expect(result.results[0].responsePreview).toBeUndefined();
  });

  it("测试全部模型时按配置顺序串行执行且单项失败后继续", async () => {
    const runtime = createRuntime();
    const first = createDeferred<ReturnType<typeof successfulMessage>>();
    const completed: string[] = [];
    (runtime.completeSimple as ReturnType<typeof vi.fn>).mockImplementationOnce(async (model: typeof modelA) => {
      completed.push(model.id);
      return first.promise;
    }).mockImplementationOnce(async (model: typeof modelA) => {
      completed.push(model.id);
      throw new Error("Bearer secret-token 请求失败");
    });
    const coordinator = createRuntimeCoordinator({ modelRuntime: runtime, runtimeSupervisor: createManager() });

    const pending = coordinator.testModels("provider-2", { scope: "all" });
    await Promise.resolve();
    expect(completed).toEqual(["model-a"]);
    first.resolve(successfulMessage());
    const result = await pending;

    expect(completed).toEqual(["model-a", "model-b"]);
    expect(result.results).toEqual([
      expect.objectContaining({ modelId: "model-a", ok: true }),
      expect.objectContaining({ modelId: "model-b", ok: false, message: "模型请求失败" }),
    ]);
    expect(result.results[1].message).not.toContain("secret-token");
  });
});
