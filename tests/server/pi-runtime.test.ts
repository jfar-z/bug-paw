// @vitest-environment node

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceResourceLoader,
  createPiRuntimeGateway,
  assertManagedSessionFile,
  PiRuntimeError,
  type ChatEvent,
  type PiRuntimeBackend,
  type PiSessionAdapter,
} from "../../src/server/pi-runtime";
import type { RunCheckpoint, RunCheckpointStore } from "../../src/server/runtime/checkpoint-store";
import { SYSTEM_LIMITS } from "../../src/server/core/limits";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

class FakeSession implements PiSessionAdapter {
  readonly sessionFile: string;
  readonly messages: unknown[] = [];
  readonly model = { provider: "test", id: "model-1", name: "Model 1" };
  isStreaming = false;
  streamingMessage?: unknown;
  readonly abort = vi.fn(async () => undefined);
  readonly reload = vi.fn(async () => undefined);
  readonly setModel = vi.fn(async () => undefined);
  readonly setSessionName = vi.fn();
  readonly dispose = vi.fn();
  private listener?: (event: AgentSessionEvent) => void;
  private promptCompletion?: () => void;

  constructor(readonly sessionId = "session-1") {
    this.sessionFile = `/data/pi/sessions/${sessionId}.jsonl`;
  }

  subscribe(listener: (event: AgentSessionEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  prompt = vi.fn(async () => {
    this.isStreaming = true;
    await new Promise<void>((resolve) => {
      this.promptCompletion = resolve;
    });
    this.isStreaming = false;
  });

  emit(event: AgentSessionEvent) {
    this.listener?.(event);
  }

  finishPrompt() {
    this.promptCompletion?.();
  }
}

function createBackend(session: FakeSession): PiRuntimeBackend {
  return {
    listModels: vi.fn(async () => [{ provider: "test", id: "model-1", name: "Model 1" }]),
    listCommands: vi.fn(async () => []),
    listSessions: vi.fn(async () => [{
      id: session.sessionId,
      path: session.sessionFile!,
      created: "2026-08-05T08:00:00.000Z",
      modified: "2026-08-05T08:00:00.000Z",
      messageCount: 1,
      firstMessage: "测试会话",
    }]),
    createSession: vi.fn(async () => session),
    openSession: vi.fn(async () => session),
    findModel: vi.fn(() => ({ provider: "test", id: "model-1", name: "Model 1" })),
    deleteSession: vi.fn(async () => undefined),
  };
}

function createMultiSessionBackend(sessions: FakeSession[]): PiRuntimeBackend {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  return {
    listModels: vi.fn(async () => [{ provider: "test", id: "model-1", name: "Model 1" }]),
    listCommands: vi.fn(async () => []),
    listSessions: vi.fn(async () => sessions.map((session) => ({
      id: session.sessionId,
      path: session.sessionFile,
      created: "2026-08-05T08:00:00.000Z",
      modified: "2026-08-05T08:00:00.000Z",
      messageCount: 1,
      firstMessage: "测试会话",
    }))),
    createSession: vi.fn(async () => sessions[0]),
    openSession: vi.fn(async (sessionId: string) => byId.get(sessionId)!),
    findModel: vi.fn(() => ({ provider: "test", id: "model-1", name: "Model 1" })),
    deleteSession: vi.fn(async () => undefined),
  };
}

function createMetadataStore() {
  const archived = new Set<string>();
  return {
    isArchived: vi.fn(async (sessionId: string) => archived.has(sessionId)),
    listArchivedIds: vi.fn(async () => [...archived]),
    archive: vi.fn(async (sessionId: string) => { archived.add(sessionId); }),
    unarchive: vi.fn(async (sessionId: string) => { archived.delete(sessionId); }),
    remove: vi.fn(async (sessionId: string) => { archived.delete(sessionId); }),
  };
}

describe("PiRuntimeGateway", () => {
  it("向扩展能力通知可信 Run 的开始和完成", async () => {
    const session = new FakeSession();
    const onRunStarted = vi.fn();
    const onRunFinished = vi.fn(async () => undefined);
    const gateway = createPiRuntimeGateway(createBackend(session), { onRunStarted, onRunFinished });
    await gateway.createSession();

    const started = await gateway.startPrompt("session-1", "检查页面");
    expect(onRunStarted).toHaveBeenCalledWith({ runId: started.runId, sessionId: "session-1" });
    session.finishPrompt();
    await vi.waitFor(() => expect(onRunFinished).toHaveBeenCalledWith({
      runId: started.runId,
      sessionId: "session-1",
      status: "completed",
    }));
    expect(onRunFinished).toHaveBeenCalledTimes(1);
  });

  it("pi 尚未落盘时仍在会话列表返回正在生成的首条消息", async () => {
    const session = new FakeSession();
    const backend = createBackend(session);
    vi.mocked(backend.listSessions).mockResolvedValue([]);
    const gateway = createPiRuntimeGateway(backend);
    await gateway.createSession();
    await gateway.startPrompt("session-1", "首条问题");

    expect(await gateway.listSessions()).toEqual([expect.objectContaining({
      id: "session-1",
      firstMessage: "首条问题",
      messageCount: 1,
    })]);
    session.finishPrompt();
  });

  it("pi 会话落盘后使用磁盘摘要替换同 ID 临时摘要", async () => {
    const session = new FakeSession();
    const backend = createBackend(session);
    vi.mocked(backend.listSessions)
      .mockResolvedValueOnce([])
      .mockResolvedValue([{
        id: "session-1",
        path: session.sessionFile!,
        created: "2026-08-05T08:00:00.000Z",
        modified: "2026-08-05T08:01:00.000Z",
        messageCount: 2,
        firstMessage: "pi 已落盘",
      }]);
    const gateway = createPiRuntimeGateway(backend);
    await gateway.createSession();
    await gateway.startPrompt("session-1", "临时问题");

    expect(await gateway.listSessions()).toHaveLength(1);
    expect(await gateway.listSessions()).toEqual([
      expect.objectContaining({ id: "session-1", firstMessage: "pi 已落盘" }),
    ]);
    session.finishPrompt();
  });

  it("只允许删除受管目录内的 JSONL 会话文件", () => {
    expect(assertManagedSessionFile("/data/pi/sessions", "/data/pi/sessions/session-1.jsonl"))
      .toBe("/data/pi/sessions/session-1.jsonl");
    expect(() => assertManagedSessionFile("/data/pi/sessions", "/data/pi/outside.jsonl"))
      .toThrow("受管目录");
    expect(() => assertManagedSessionFile("/data/pi/sessions", "/data/pi/sessions/session-1.txt"))
      .toThrow("受管目录");
  });

  it("使用 pi 原生会话信息重命名并清理换行", async () => {
    const session = new FakeSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();

    await gateway.renameSession("session-1", "  新名称\n第二行  ");

    expect(session.setSessionName).toHaveBeenCalledWith("新名称 第二行");
    await expect(gateway.renameSession("session-1", "   ")).rejects.toMatchObject({ code: "INVALID_SESSION_NAME" });
  });

  it("切换模型后向所有订阅者发布有序模型事件", async () => {
    const session = new FakeSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();
    const firstClient: ChatEvent[] = [];
    const secondClient: ChatEvent[] = [];
    gateway.subscribe("session-1", (event) => firstClient.push(event));
    gateway.subscribe("session-1", (event) => secondClient.push(event));

    await gateway.setModel("session-1", "test", "model-1");

    expect(firstClient.at(-1)).toMatchObject({ id: 1, type: "model_changed", model: { provider: "test", id: "model-1" } });
    expect(secondClient.at(-1)).toEqual(firstClient.at(-1));
  });

  it("Runtime drain 等待非 Turn 事件检查点完成后才允许释放", async () => {
    const session = new FakeSession();
    const saving = deferred<void>();
    const save = vi.fn(async () => saving.promise);
    const store: RunCheckpointStore = {
      load: vi.fn(async () => undefined),
      save,
      remove: vi.fn(async () => undefined),
      markInterrupted: vi.fn(async () => undefined),
    };
    const gateway = createPiRuntimeGateway(createBackend(session), { checkpointStore: store });
    await gateway.createSession();
    await gateway.setModel("session-1", "test", "model-1");

    let drained = false;
    const draining = gateway.drain?.().then(() => { drained = true; });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(drained).toBe(false);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ sessionId: "session-1", lastEventId: 1 });
    saving.resolve();
    await draining;
    expect(drained).toBe(true);
    gateway.dispose();
  });

  it("同一会话的快速模型切换按请求顺序执行并广播最终模型", async () => {
    const session = new FakeSession();
    const firstChange = deferred<void>();
    session.setModel.mockImplementationOnce(() => firstChange.promise).mockResolvedValue(undefined);
    const backend = createBackend(session);
    vi.mocked(backend.findModel).mockImplementation((provider, id) => ({ provider, id, name: id }));
    const gateway = createPiRuntimeGateway(backend);
    await gateway.createSession();
    const events: ChatEvent[] = [];
    gateway.subscribe(session.sessionId, (event) => events.push(event));

    const first = gateway.setModel(session.sessionId, "test", "model-a");
    await vi.waitFor(() => expect(session.setModel).toHaveBeenCalledOnce());
    const second = gateway.setModel(session.sessionId, "test", "model-b");
    await Promise.resolve();
    expect(session.setModel).toHaveBeenCalledOnce();
    firstChange.resolve();
    await Promise.all([first, second]);

    expect(session.setModel.mock.calls.map(([model]) => (model as { id: string }).id)).toEqual(["model-a", "model-b"]);
    expect(events.filter((event) => event.type === "model_changed").map((event) => event.type === "model_changed" ? event.model.id : ""))
      .toEqual(["model-a", "model-b"]);
  });

  it("按最终 UTF-8 事件大小裁剪多字节文本增量", async () => {
    const session = new FakeSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();
    const events: ChatEvent[] = [];
    gateway.subscribe(session.sessionId, (event) => events.push(event));

    session.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "🧪".repeat(SYSTEM_LIMITS.realtimeEventBytes) } as never,
    });

    const event = events.at(-1)!;
    expect(event.type).toBe("text_delta");
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(SYSTEM_LIMITS.realtimeEventBytes);
  });

  it("会话元数据删除失败时恢复已暂存的会话文件", async () => {
    const session = new FakeSession();
    const backend = createBackend(session);
    const commit = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    backend.stageDeleteSession = vi.fn(async () => ({ commit, rollback }));
    const metadataStore = createMetadataStore();
    metadataStore.remove.mockRejectedValueOnce(new Error("database failed"));
    const gateway = createPiRuntimeGateway(backend, { sessionMetadataStore: metadataStore });
    await gateway.createSession();

    await expect(gateway.deleteSession(session.sessionId)).rejects.toThrow("database failed");

    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    await expect(gateway.openSession(session.sessionId)).resolves.toMatchObject({ id: session.sessionId });
  });

  it("按 Web 元数据区分普通会话和归档会话", async () => {
    const session = new FakeSession();
    const metadataStore = createMetadataStore();
    const gateway = createPiRuntimeGateway(createBackend(session), { sessionMetadataStore: metadataStore });

    await gateway.archiveSession("session-1");
    expect(await gateway.listSessions({ archived: false })).toEqual([]);
    expect(await gateway.listSessions({ archived: true })).toHaveLength(1);

    await gateway.unarchiveSession("session-1");
    expect(await gateway.listSessions({ archived: false })).toHaveLength(1);
  });

  it("活动会话拒绝归档和删除", async () => {
    const session = new FakeSession();
    const metadataStore = createMetadataStore();
    const backend = createBackend(session);
    const gateway = createPiRuntimeGateway(backend, { sessionMetadataStore: metadataStore });
    await gateway.createSession();
    await gateway.startPrompt("session-1", "长任务");

    await expect(gateway.archiveSession("session-1")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    await expect(gateway.deleteSession("session-1")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect(backend.deleteSession).not.toHaveBeenCalled();
    session.finishPrompt();
  });

  it("删除会话时释放已打开 adapter 并清理归档元数据", async () => {
    const session = new FakeSession();
    const metadataStore = createMetadataStore();
    const backend = createBackend(session);
    const gateway = createPiRuntimeGateway(backend, { sessionMetadataStore: metadataStore });
    await gateway.createSession();
    await gateway.archiveSession("session-1");
    await gateway.unarchiveSession("session-1");

    await gateway.deleteSession("session-1");

    expect(session.dispose).toHaveBeenCalledOnce();
    expect(backend.deleteSession).toHaveBeenCalledWith("session-1");
    expect(metadataStore.remove).toHaveBeenCalledWith("session-1");
  });

  it("从 Pi 会话恢复消息、从检查点恢复运行终态", async () => {
    const session = new FakeSession();
    session.messages.push({ role: "assistant", content: [{ type: "text", text: "Pi 历史事实源" }] });
    const checkpoint: RunCheckpoint = {
      version: 1,
      runId: "run-old",
      sessionId: "session-1",
      status: "interrupted",
      startedAt: "2026-08-05T08:00:00.000Z",
      finishedAt: "2026-08-05T08:01:00.000Z",
      lastEventId: 9,
      messages: [{ role: "assistant", content: [{ type: "text", text: "已恢复的部分回答" }] }],
      events: [],
    };
    const store: RunCheckpointStore = {
      load: vi.fn(async () => checkpoint),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      markInterrupted: vi.fn(async () => undefined),
    };
    const gateway = createPiRuntimeGateway(createBackend(session), { checkpointStore: store });
    await gateway.openSession("session-1");
    const events: ChatEvent[] = [];

    gateway.subscribe("session-1", undefined, (event) => events.push(event));

    expect(events[0]).toMatchObject({
      type: "snapshot",
      lastEventId: 9,
      messages: session.messages,
      run: { runId: "run-old", status: "interrupted" },
    });
  });

  it("服务重启丢失内存事件后要求旧游标订阅者重新读取 Projection", async () => {
    const session = new FakeSession();
    const checkpoint: RunCheckpoint = {
      version: 1,
      runId: "run-old",
      sessionId: "session-1",
      status: "interrupted",
      startedAt: "2026-08-05T08:00:00.000Z",
      finishedAt: "2026-08-05T08:01:00.000Z",
      lastEventId: 9,
      messages: [{ role: "assistant", content: [{ type: "text", text: "重启后恢复" }] }],
      events: [],
    };
    const store: RunCheckpointStore = {
      load: vi.fn(async () => checkpoint),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      markInterrupted: vi.fn(async () => undefined),
    };
    const gateway = createPiRuntimeGateway(createBackend(session), { checkpointStore: store });
    await gateway.openSession("session-1");
    const events: ChatEvent[] = [];

    gateway.subscribe("session-1", 5, (event) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "projection_required", lastEventId: 9 });
  });

  it("启动生成后立即返回运行标识而不等待 Prompt 完成", async () => {
    const session = new FakeSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();

    const started = await gateway.startPrompt(session.sessionId, "长任务");

    expect(started).toMatchObject({
      sessionId: "session-1",
      status: "running",
    });
    expect(started.runId).toEqual(expect.any(String));
    expect(session.isStreaming).toBe(true);
    session.finishPrompt();
  });

  it("批量中断所有活动 run 并返回已请求中断数量", async () => {
    const first = new FakeSession("session-1");
    const second = new FakeSession("session-2");
    const gateway = createPiRuntimeGateway(createMultiSessionBackend([first, second]));
    await gateway.openSession(first.sessionId);
    await gateway.openSession(second.sessionId);
    await gateway.startPrompt(first.sessionId, "第一项长任务");
    await gateway.startPrompt(second.sessionId, "第二项长任务");

    await expect(gateway.abortAll()).resolves.toBe(2);
    expect(first.abort).toHaveBeenCalledOnce();
    expect(second.abort).toHaveBeenCalledOnce();
    first.finishPrompt();
    second.finishPrompt();
  });

  it("向多个订阅者发布同一组严格递增的运行事件", async () => {
    const session = new FakeSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();
    const first: ChatEvent[] = [];
    const second: ChatEvent[] = [];
    gateway.subscribe(session.sessionId, undefined, (event) => first.push(event));
    gateway.subscribe(session.sessionId, undefined, (event) => second.push(event));

    const started = await gateway.startPrompt(session.sessionId, "检查目录");
    session.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "处理中" } as never,
    });
    session.finishPrompt();
    await vi.waitFor(() => expect(first.at(-1)?.type).toBe("completed"));

    const firstRunEvents = first.filter((event) => event.runId === started.runId);
    const secondRunEvents = second.filter((event) => event.runId === started.runId);
    expect(secondRunEvents).toEqual(firstRunEvents);
    expect(firstRunEvents.map((event) => event.type)).toEqual(["run_started", "snapshot", "text_delta", "snapshot", "completed"]);
    expect(firstRunEvents.map((event) => event.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("按事件游标补发断线期间的增量", async () => {
    const session = new FakeSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();
    await gateway.startPrompt(session.sessionId, "检查目录");
    session.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "第一段" } as never,
    });
    session.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "第二段" } as never,
    });
    const replayed: ChatEvent[] = [];

    gateway.subscribe(session.sessionId, 1, (event) => replayed.push(event));

    expect(replayed.map((event) => event.id)).toEqual([2, 3, 4]);
    expect(replayed.map((event) => event.type)).toEqual(["snapshot", "text_delta", "text_delta"]);
    session.finishPrompt();
  });

  it("活动会话快照优先返回 pi 实时流式消息而不是滞后检查点", async () => {
    const session = new FakeSession();
    session.messages.push({ role: "user", content: "继续回答" });
    const store: RunCheckpointStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      markInterrupted: vi.fn(async () => undefined),
    };
    const gateway = createPiRuntimeGateway(createBackend(session), {
      checkpointStore: store,
      checkpointThrottleMs: 0,
    });
    await gateway.createSession();
    await gateway.startPrompt("session-1", "继续回答");
    await vi.waitFor(() => expect(store.save).toHaveBeenCalled());
    expect(store.save).toHaveBeenCalledWith(expect.not.objectContaining({ messages: expect.anything() }));
    session.streamingMessage = {
      role: "assistant",
      content: [{ type: "text", text: "刷新前已有内容" }],
    };
    const events: ChatEvent[] = [];

    gateway.subscribe("session-1", undefined, (event) => events.push(event));

    expect(events[0]).toMatchObject({
      type: "snapshot",
      messages: [
        { role: "user", content: "继续回答" },
        { role: "assistant", content: [{ type: "text", text: "刷新前已有内容" }] },
      ],
    });
    session.streamingMessage = {
      role: "assistant",
      content: [{ type: "text", text: "刷新前已有内容刷新后" }],
    };
    session.emit({
      type: "message_update",
      message: session.streamingMessage as never,
      assistantMessageEvent: { type: "text_delta", delta: "刷新后" } as never,
    });

    expect(events.map((event) => event.type)).toEqual(["snapshot", "text_delta"]);
    expect(events[1]).toMatchObject({ type: "text_delta", delta: "刷新后" });
    session.finishPrompt();
  });

  it("长历史首连改发 Projection 恢复信号而不推送超限快照", async () => {
    const session = new FakeSession();
    session.messages.push({ role: "assistant", content: "x".repeat(600 * 1024) });
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.openSession("session-1");
    const events: ChatEvent[] = [];

    gateway.subscribe("session-1", undefined, (event) => events.push(event));

    expect(events).toEqual([expect.objectContaining({
      type: "projection_required",
      sessionId: "session-1",
      lastEventId: 0,
    })]);
  });

  it("通过 ResourceLoader 注册系统提示词注入扩展", async () => {
    const loader = createWorkspaceResourceLoader(
      "/tmp/workspace",
      "/tmp/pi-agent-test",
      ["用户自定义 Agent 设定"],
      { knowledgeSearch: false, knowledgeRead: false, webSearch: true, webRead: true },
    );
    await loader.reload();

    expect(loader.getAppendSystemPrompt()).toEqual(["用户自定义 Agent 设定"]);
    expect(loader.getExtensions().extensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "<inline:bug-paw-system-prompt-injection>", hidden: true }),
    ]));
  });

  it("将文本、思考和工具增量事件标准化后推送给订阅者", async () => {
    const session = new FakeSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();
    const events: ChatEvent[] = [];
    gateway.subscribe(session.sessionId, (event) => events.push(event));

    session.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "你好" } as never,
    });
    session.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "thinking_delta", delta: "分析中" } as never,
    });
    session.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { cmd: "pwd" } });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { cmd: "pwd" },
      partialResult: { content: "/data/workspace" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: "/data/workspace" },
      isError: false,
    });

    expect(events).toEqual([
      expect.objectContaining({ type: "snapshot", sessionId: "session-1" }),
      expect.objectContaining({ type: "text_delta", id: 1, sessionId: "session-1", delta: "你好" }),
      expect.objectContaining({ type: "thinking_delta", id: 2, sessionId: "session-1", delta: "分析中" }),
      expect.objectContaining({
        type: "tool_started",
        id: 3,
        sessionId: "session-1",
        callId: "tool-1",
        toolName: "bash",
        args: { cmd: "pwd" },
      }),
      expect.objectContaining({
        type: "tool_updated",
        id: 4,
        sessionId: "session-1",
        callId: "tool-1",
        toolName: "bash",
        partialResult: { content: "/data/workspace" },
      }),
      expect.objectContaining({
        type: "tool_finished",
        id: 5,
        sessionId: "session-1",
        callId: "tool-1",
        toolName: "bash",
        result: { content: "/data/workspace" },
        isError: false,
      }),
    ]);
  });

  it("在 thinking_end 时立即推送思考段结束事件", async () => {
    const session = new FakeSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();
    const events: ChatEvent[] = [];
    gateway.subscribe(session.sessionId, (event) => events.push(event));

    session.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "已完成思考", partial: {} } as never,
    });

    expect(events.filter((event) => event.type === "thinking_finished")).toEqual([
      expect.objectContaining({ type: "thinking_finished", sessionId: "session-1" }),
    ]);

    session.emit({ type: "message_end", message: { role: "assistant", content: [] } as never });
    expect(events.filter((event) => event.type === "thinking_finished")).toHaveLength(1);
  });

  it("同一会话生成期间拒绝并发 Prompt", async () => {
    const session = new FakeSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();

    const firstPrompt = gateway.prompt(session.sessionId, "第一个请求");
    await expect(gateway.prompt(session.sessionId, "并发请求")).rejects.toMatchObject({ code: "SESSION_BUSY" });

    session.finishPrompt();
    await firstPrompt;
  });

  it("终止生成后发出 aborted，并在释放时清理 pi 订阅", async () => {
    const session = new FakeSession();
    session.abort.mockImplementation(async () => session.finishPrompt());
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();
    const events: ChatEvent[] = [];
    gateway.subscribe(session.sessionId, (event) => events.push(event));

    const prompt = gateway.prompt(session.sessionId, "长任务");
    await gateway.abort(session.sessionId);
    await prompt;
    gateway.dispose();

    expect(events.at(-1)).toMatchObject({ type: "aborted", id: 3, sessionId: "session-1" });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("找不到会话时返回稳定错误码", async () => {
    const gateway = createPiRuntimeGateway(createBackend(new FakeSession()));

    await expect(gateway.prompt("missing", "hello")).rejects.toEqual(
      new PiRuntimeError("SESSION_NOT_FOUND", "会话不存在"),
    );
  });
});
