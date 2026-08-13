import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { useSessionStream } from "./use-session-stream";

type EventListener = (event: MessageEvent) => void;
let animationFrames: FrameRequestCallback[] = [];

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function flushAnimationFrames(time = 16): void {
  const callbacks = animationFrames;
  animationFrames = [];
  callbacks.forEach((callback) => callback(time));
}

class FakeEventSource {
  static readonly OPEN = 1;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.OPEN;
  closed = false;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() { this.closed = true; }

  emit(type: string, payload: unknown) {
    if (this.closed) return;
    this.emitQueued(type, payload);
  }

  emitQueued(type: string, payload: unknown) {
    const normalized = payload && typeof payload === "object"
      ? {
          ...(type === "snapshot"
            ? { history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 } }
            : { runId: "run-1" }),
          ...payload as Record<string, unknown>,
        }
      : payload;
    const event = { data: JSON.stringify(normalized) } as MessageEvent;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  emitRaw(type: string, data: string) {
    const event = { data } as MessageEvent;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  animationFrames = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => vi.useRealTimers());

describe("useSessionStream", () => {
  it("从 snapshot 恢复活动任务并创建等待中的 Agent 回合", () => {
    const onSnapshot = vi.fn();
    const onTimelineEvent = vi.fn();
    const onRunChange = vi.fn();
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot,
      onTimelineEvent,
      onRunChange,
      onError: vi.fn(),
    }));

    act(() => {
      FakeEventSource.instances[0].emit("snapshot", {
        id: 12,
        type: "snapshot",
        sessionId: "session-1",
        messages: [],
        lastEventId: 12,
        run: {
          runId: "run-1",
          sessionId: "session-1",
          status: "running",
          startedAt: "2026-08-05T08:00:00.000Z",
        },
      });
    });

    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1", lastEventId: 12 }));
    expect(onRunChange).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", status: "running" }));
    expect(onTimelineEvent).toHaveBeenCalledWith({ type: "generation_started" });
  });

  it("忽略重复事件并在终态清除运行状态", () => {
    const onTimelineEvent = vi.fn();
    const onRunChange = vi.fn();
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent,
      onRunChange,
      onError: vi.fn(),
    }));
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emit("run_started", {
        id: 1,
        type: "run_started",
        sessionId: "session-1",
        runId: "run-1",
        run: { runId: "run-1", sessionId: "session-1", status: "running", startedAt: "2026-08-05T08:00:00.000Z" },
      });
      source.emit("text_delta", { id: 2, type: "text_delta", sessionId: "session-1", runId: "run-1", delta: "一次" });
      source.emit("text_delta", { id: 2, type: "text_delta", sessionId: "session-1", runId: "run-1", delta: "一次" });
      source.emit("completed", { id: 3, type: "completed", sessionId: "session-1", runId: "run-1" });
    });

    expect(onTimelineEvent.mock.calls.filter(([event]) => event.type === "text_delta")).toEqual([
      [{ type: "text_delta", delta: "一次" }],
    ]);
    expect(onTimelineEvent).toHaveBeenLastCalledWith({ type: "generation_finished", outcome: "completed" });
    expect(onRunChange).toHaveBeenLastCalledWith(undefined);
  });

  it("将思考增量转交给时间线", () => {
    const onTimelineEvent = vi.fn();
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent,
      onRunChange: vi.fn(),
      onError: vi.fn(),
    }));

    act(() => {
      FakeEventSource.instances[0].emit("thinking_delta", {
        id: 1,
        type: "thinking_delta",
        sessionId: "session-1",
        delta: "分析请求",
      });
      flushAnimationFrames();
    });

    expect(onTimelineEvent).toHaveBeenCalledWith({ type: "thinking_delta", delta: "分析请求" });
  });

  it("在同一动画帧合并相邻文本增量", () => {
    const onTimelineEvent = vi.fn();
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent,
      onRunChange: vi.fn(),
      onError: vi.fn(),
    }));
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emit("text_delta", { id: 1, type: "text_delta", sessionId: "session-1", delta: "长" });
      source.emit("text_delta", { id: 2, type: "text_delta", sessionId: "session-1", delta: "输出" });
    });
    expect(onTimelineEvent).not.toHaveBeenCalled();

    act(() => flushAnimationFrames());
    expect(onTimelineEvent).toHaveBeenCalledOnce();
    expect(onTimelineEvent).toHaveBeenCalledWith({ type: "text_delta", delta: "长输出" });
  });

  it("将思考段结束事件转交给时间线", () => {
    const onTimelineEvent = vi.fn();
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent,
      onRunChange: vi.fn(),
      onError: vi.fn(),
    }));

    act(() => FakeEventSource.instances[0].emit("thinking_finished", {
      id: 2,
      type: "thinking_finished",
      sessionId: "session-1",
    }));

    expect(onTimelineEvent).toHaveBeenCalledWith({ type: "thinking_finished" });
  });

  it("转交工具准备阶段并保留运行中止原因", () => {
    const onTimelineEvent = vi.fn();
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent,
      onRunChange: vi.fn(),
      onError: vi.fn(),
    }));
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emit("tool_preparing", {
        id: 1,
        type: "tool_preparing",
        sessionId: "session-1",
        runId: "run-1",
        callId: "call-1",
        toolName: "write",
      });
      source.emit("tool_prepared", {
        id: 2,
        type: "tool_prepared",
        sessionId: "session-1",
        runId: "run-1",
        callId: "call-1",
        toolName: "write",
        args: { path: "src/app.ts", content: "内容" },
      });
      source.emit("tool_parameters_streaming", {
        id: 3,
        type: "tool_parameters_streaming",
        sessionId: "session-1",
        runId: "run-1",
        callId: "call-1",
        toolName: "write",
        generatedBytes: 4608,
        path: "src/app.ts",
      });
      source.emit("aborted", {
        id: 4,
        type: "aborted",
        sessionId: "session-1",
        runId: "run-1",
      });
    });

    expect(onTimelineEvent).toHaveBeenNthCalledWith(1, {
      type: "tool_preparing",
      callId: "call-1",
      toolName: "write",
    });
    expect(onTimelineEvent).toHaveBeenNthCalledWith(2, {
      type: "tool_prepared",
      callId: "call-1",
      toolName: "write",
      args: { path: "src/app.ts", content: "内容" },
    });
    expect(onTimelineEvent).toHaveBeenNthCalledWith(3, {
      type: "tool_parameters_streaming",
      callId: "call-1",
      toolName: "write",
      generatedBytes: 4608,
      path: "src/app.ts",
    });
    expect(onTimelineEvent).toHaveBeenLastCalledWith({
      type: "generation_finished",
      outcome: "aborted",
    });
  });

  it("连接错误只报告重连状态而不结束任务", () => {
    const onTimelineEvent = vi.fn();
    const onRunChange = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent,
      onRunChange,
      onError,
    }));

    act(() => FakeEventSource.instances[0].onerror?.());

    expect(result.current.reconnecting).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onRunChange).not.toHaveBeenCalled();
    expect(onTimelineEvent).not.toHaveBeenCalled();
  });

  it("拒绝损坏 JSON 和缺少事件序号的增量，不污染当前时间线", () => {
    const onTimelineEvent = vi.fn();
    const onError = vi.fn();
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent,
      onRunChange: vi.fn(),
      onError,
    }));
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emitRaw("text_delta", "{broken-json");
      source.emit("text_delta", { type: "text_delta", sessionId: "session-1", delta: "不应接受" });
    });

    expect(onTimelineEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("实时事件格式无效，正在等待会话状态恢复。");
  });

  it("收到 Projection 缺口控制事件后重新读取完整会话", async () => {
    const onSnapshot = vi.fn();
    const onTimelineEvent = vi.fn();
    const recovery = deferred<Awaited<ReturnType<typeof api.openSession>>>();
    const openSession = vi.spyOn(api, "openSession").mockReturnValue(recovery.promise);
    const recovered = {
      id: "session-1",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
      lastEventId: 9,
    };
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot,
      onTimelineEvent,
      onRunChange: vi.fn(),
      onError: vi.fn(),
    }));

    await act(async () => {
      FakeEventSource.instances[0].emit("projection_required", {
        id: 9,
        type: "projection_required",
        sessionId: "session-1",
        lastEventId: 9,
      });
      FakeEventSource.instances[0].emitQueued("text_delta", {
        id: 10,
        type: "text_delta",
        sessionId: "session-1",
        delta: "恢复期间不得应用",
      });
      recovery.resolve(recovered);
      await Promise.resolve();
    });

    expect(openSession).toHaveBeenCalledWith("session-1", expect.any(AbortSignal));
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1", lastEventId: 9 }));
    expect(onTimelineEvent).not.toHaveBeenCalled();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1]?.url).toBe("/api/v1/sessions/session-1/events?after=9");
  });

  it("Projection 快照请求永久挂起时按截止时间中止并恢复 SSE", async () => {
    vi.useFakeTimers();
    let recoverySignal: AbortSignal | undefined;
    const onError = vi.fn();
    const onUnexpectedError = vi.fn();
    vi.spyOn(api, "openSession").mockImplementation((_sessionId, signal) => {
      recoverySignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent: vi.fn(),
      onRunChange: vi.fn(),
      onError,
      onUnexpectedError,
    }));

    await act(async () => {
      FakeEventSource.instances[0].emit("projection_required", {
        id: 9,
        type: "projection_required",
        sessionId: "session-1",
        lastEventId: 9,
      });
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(recoverySignal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onUnexpectedError).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe("/api/v1/sessions/session-1/events?after=0");
  });

  it("Projection 快照恢复遇到真实请求错误时仅上报一次意外错误", async () => {
    const failure = new Error("projection unavailable");
    const onUnexpectedError = vi.fn();
    vi.spyOn(api, "openSession").mockRejectedValue(failure);
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent: vi.fn(),
      onRunChange: vi.fn(),
      onError: vi.fn(),
      onUnexpectedError,
    }));

    await act(async () => {
      FakeEventSource.instances[0].emit("projection_required", {
        id: 9,
        type: "projection_required",
        sessionId: "session-1",
        lastEventId: 9,
      });
      await Promise.resolve();
    });

    expect(onUnexpectedError).toHaveBeenCalledTimes(1);
    expect(onUnexpectedError).toHaveBeenCalledWith(failure);
  });

  it("把其他客户端切换的模型同步到当前页面", () => {
    const onModelChange = vi.fn();
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent: vi.fn(),
      onRunChange: vi.fn(),
      onModelChange,
      onError: vi.fn(),
    }));

    act(() => FakeEventSource.instances[0].emit("model_changed", {
      id: 1,
      type: "model_changed",
      sessionId: "session-1",
      model: { provider: "openai", id: "gpt", name: "GPT" },
    }));

    expect(onModelChange).toHaveBeenCalledWith({ provider: "openai", id: "gpt", name: "GPT" });
  });

  it("把其他客户端切换的思考深度同步到当前页面", () => {
    const onThinkingLevelChange = vi.fn();
    renderHook(() => useSessionStream({
      sessionId: "session-1",
      onSnapshot: vi.fn(),
      onTimelineEvent: vi.fn(),
      onRunChange: vi.fn(),
      onThinkingLevelChange,
      onError: vi.fn(),
    }));

    act(() => FakeEventSource.instances[0].emit("thinking_level_changed", {
      id: 1,
      type: "thinking_level_changed",
      sessionId: "session-1",
      thinkingLevel: "high",
    }));

    expect(onThinkingLevelChange).toHaveBeenCalledWith("high");
  });

  it("切换 Session 后拒绝旧 transport 已排队的事件且不污染新游标", () => {
    const onTimelineEvent = vi.fn();
    const onModelChange = vi.fn();
    const { rerender } = renderHook(
      ({ sessionId }) => useSessionStream({
        sessionId,
        onSnapshot: vi.fn(),
        onTimelineEvent,
        onRunChange: vi.fn(),
        onModelChange,
        onError: vi.fn(),
      }),
      { initialProps: { sessionId: "session-old" } },
    );
    const oldSource = FakeEventSource.instances[0];
    rerender({ sessionId: "session-new" });
    const newSource = FakeEventSource.instances[1];

    act(() => {
      oldSource.emitQueued("model_changed", {
        id: 99,
        type: "model_changed",
        sessionId: "session-old",
        model: { provider: "old", id: "old", name: "Old" },
      });
      newSource.emit("text_delta", {
        id: 1,
        type: "text_delta",
        sessionId: "session-new",
        delta: "新会话",
      });
      flushAnimationFrames();
    });

    expect(onModelChange).not.toHaveBeenCalled();
    expect(onTimelineEvent).toHaveBeenCalledWith({ type: "text_delta", delta: "新会话" });
  });
});
