import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThinkingLevel } from "../../../shared/configuration-contracts";
import type { ModelSummary, SessionSnapshot } from "../../api";
import { ChatInteractionCoordinator, clearChatInteractionTrace } from "./chat-interaction-coordinator";
import { normalizeThinkingLevelForModel, useChatRuntimeControls } from "./use-chat-runtime-controls";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const modelA: ModelSummary = {
  provider: "test",
  id: "model-a",
  name: "模型 A",
  thinkingLevels: ["low", "medium", "high"],
};
const modelB: ModelSummary = {
  provider: "test",
  id: "model-b",
  name: "模型 B",
  thinkingLevels: ["off", "low"],
};
const modelC: ModelSummary = {
  provider: "test",
  id: "model-c",
  name: "模型 C",
  thinkingLevels: ["medium", "high"],
};

function snapshot(id: string, model: ModelSummary = modelA, thinkingLevel: ThinkingLevel = "medium"): SessionSnapshot {
  return {
    id,
    messages: [],
    history: { branchToken: `branch-${id}`, hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
    model,
    thinkingLevel,
    lastEventId: 0,
  };
}

function setup() {
  const coordinator = new ChatInteractionCoordinator();
  const onSessionRuntimeChange = vi.fn();
  const onFailure = vi.fn(async () => undefined);
  const persistence = {
    setModel: vi.fn<(sessionId: string, provider: string, modelId: string) => Promise<void>>(async () => undefined),
    setThinkingLevel: vi.fn<(sessionId: string, thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => Promise<void>>(async () => undefined),
  };
  const hook = renderHook(() => useChatRuntimeControls({
    coordinator,
    guardInteraction: (ticket, checkpoint) => coordinator.guard(ticket, checkpoint),
    onSessionRuntimeChange,
    onFailure,
    persistence,
  }));
  act(() => hook.result.current.applySnapshotRuntime(snapshot("session-1")));
  return { ...hook, coordinator, onSessionRuntimeChange, onFailure, persistence };
}

describe("useChatRuntimeControls", () => {
  beforeEach(() => clearChatInteractionTrace());

  it("快速连续切换模型时按队列写入并只保留最后一次选择", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const runtime = setup();
    runtime.persistence.setModel
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    let firstChange!: Promise<void>;
    let secondChange!: Promise<void>;
    act(() => {
      firstChange = runtime.result.current.changeModel(modelB);
      secondChange = runtime.result.current.changeModel(modelC);
    });

    expect(runtime.result.current.selectedModel).toBe(modelC);
    await waitFor(() => expect(runtime.persistence.setModel).toHaveBeenCalledTimes(1));
    expect(runtime.result.current.runtimeChanging).toBe(true);
    first.reject(new Error("first failed"));
    await waitFor(() => expect(runtime.persistence.setModel).toHaveBeenCalledTimes(2));
    second.resolve();
    await act(async () => Promise.all([firstChange, secondChange]));

    expect(runtime.result.current.selectedModel).toBe(modelC);
    expect(runtime.result.current.runtimeChanging).toBe(false);
    expect(runtime.onFailure).not.toHaveBeenCalled();
    expect(runtime.onSessionRuntimeChange).toHaveBeenLastCalledWith("session-1", { model: modelC });
  });

  it("单次模型切换失败时恢复权威模型与兼容思考深度", async () => {
    const runtime = setup();
    runtime.persistence.setModel.mockRejectedValueOnce(new Error("model unavailable"));

    await act(async () => runtime.result.current.changeModel(modelB));

    expect(runtime.result.current.selectedModel).toBe(modelA);
    expect(runtime.result.current.selectedThinkingLevel).toBe("medium");
    expect(runtime.onFailure).toHaveBeenCalledWith(expect.any(Error), "切换会话模型");
  });

  it("前一次模型已落盘而后一次失败时恢复到服务端真实模型", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const runtime = setup();
    runtime.persistence.setModel
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    let firstChange!: Promise<void>;
    let secondChange!: Promise<void>;
    act(() => {
      firstChange = runtime.result.current.changeModel(modelB);
      secondChange = runtime.result.current.changeModel(modelC);
    });

    await waitFor(() => expect(runtime.persistence.setModel).toHaveBeenCalledTimes(1));
    first.resolve();
    await waitFor(() => expect(runtime.persistence.setModel).toHaveBeenCalledTimes(2));
    second.reject(new Error("second failed"));
    await act(async () => Promise.all([firstChange, secondChange]));

    expect(runtime.result.current.selectedModel).toBe(modelB);
    expect(runtime.result.current.selectedThinkingLevel).toBe("low");
    expect(runtime.onFailure).toHaveBeenCalledWith(expect.any(Error), "切换会话模型");
  });

  it("旧 Session 的模型响应在切换后不能回写新 Session", async () => {
    const pending = deferred<void>();
    const runtime = setup();
    runtime.persistence.setModel.mockImplementationOnce(() => pending.promise);
    let change!: Promise<void>;
    act(() => { change = runtime.result.current.changeModel(modelB); });

    act(() => {
      runtime.result.current.invalidateSessionRuntime("open-session");
      runtime.result.current.applySnapshotRuntime(snapshot("session-2", modelC, "high"));
    });
    pending.resolve();
    await act(async () => change);

    expect(runtime.result.current.selectedModel).toBe(modelC);
    expect(runtime.result.current.selectedThinkingLevel).toBe("high");
    expect(runtime.onSessionRuntimeChange).not.toHaveBeenCalled();
  });

  it("模型 SSE 不覆盖仍在等待持久化的更新选择", async () => {
    const pending = deferred<void>();
    const runtime = setup();
    runtime.persistence.setModel.mockImplementationOnce(() => pending.promise);
    let change!: Promise<void>;
    act(() => { change = runtime.result.current.changeModel(modelB); });

    act(() => runtime.result.current.applyModelEvent("session-1", modelA));
    expect(runtime.result.current.selectedModel).toBe(modelB);

    pending.resolve();
    await act(async () => change);
    expect(runtime.result.current.selectedModel).toBe(modelB);
  });

  it("模型与思考深度共享同一 Session 串行队列", async () => {
    const modelRequest = deferred<void>();
    const thinkingRequest = deferred<void>();
    const runtime = setup();
    runtime.persistence.setModel.mockImplementationOnce(() => modelRequest.promise);
    runtime.persistence.setThinkingLevel.mockImplementationOnce(() => thinkingRequest.promise);
    let modelChange!: Promise<void>;
    let thinkingChange!: Promise<void>;
    act(() => {
      modelChange = runtime.result.current.changeModel(modelC);
      thinkingChange = runtime.result.current.changeThinkingLevel("high");
    });

    await waitFor(() => expect(runtime.persistence.setModel).toHaveBeenCalledTimes(1));
    expect(runtime.persistence.setThinkingLevel).not.toHaveBeenCalled();
    modelRequest.resolve();
    await waitFor(() => expect(runtime.persistence.setThinkingLevel).toHaveBeenCalledTimes(1));
    thinkingRequest.resolve();
    await act(async () => Promise.all([modelChange, thinkingChange]));

    expect(runtime.result.current.selectedModel).toBe(modelC);
    expect(runtime.result.current.selectedThinkingLevel).toBe("high");
  });

  it("快速连续切换思考深度时忽略前一次失败并保留最终值", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const runtime = setup();
    runtime.persistence.setThinkingLevel
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    let firstChange!: Promise<void>;
    let secondChange!: Promise<void>;
    act(() => {
      firstChange = runtime.result.current.changeThinkingLevel("low");
      secondChange = runtime.result.current.changeThinkingLevel("high");
    });

    await waitFor(() => expect(runtime.persistence.setThinkingLevel).toHaveBeenCalledTimes(1));
    first.reject(new Error("first failed"));
    await waitFor(() => expect(runtime.persistence.setThinkingLevel).toHaveBeenCalledTimes(2));
    second.resolve();
    await act(async () => Promise.all([firstChange, secondChange]));

    expect(runtime.result.current.selectedThinkingLevel).toBe("high");
    expect(runtime.result.current.runtimeChanging).toBe(false);
    expect(runtime.onFailure).not.toHaveBeenCalled();
    expect(runtime.onSessionRuntimeChange).toHaveBeenLastCalledWith("session-1", { thinkingLevel: "high" });
  });

  it("模型不支持原思考深度时选择最近的可用档位", () => {
    expect(normalizeThinkingLevelForModel("medium", modelB)).toBe("low");
    expect(normalizeThinkingLevelForModel("minimal", modelC)).toBe("medium");
  });
});
