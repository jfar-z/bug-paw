// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  createPiRuntimeGateway,
  createWorkspaceResourceLoader,
  type ModelSummary,
  type PiRuntimeBackend,
  type PiSessionAdapter,
} from "./pi-runtime";

/** 创建受测试控制的异步值。 */
function createDeferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

/** 以最小实现模拟 SDK 会话，记录 reload 调用。 */
function createSession(
  prompt: () => Promise<void> = async () => undefined,
  messages: unknown[] = [],
  model: unknown = undefined,
): PiSessionAdapter & { reload: ReturnType<typeof vi.fn>; setSessionName: ReturnType<typeof vi.fn> } {
  return {
    sessionId: "session-1",
    sessionFile: undefined,
    messages,
    model,
    isStreaming: false,
    subscribe: () => () => undefined,
    prompt,
    reload: vi.fn(async () => undefined),
    abort: async () => undefined,
    setModel: async () => undefined,
    setSessionName: vi.fn<(name: string) => void>(),
    dispose: () => undefined,
  };
}

/** 创建只提供单会话的运行时后端。 */
function createBackend(
  session: PiSessionAdapter,
  generateSessionTitle?: PiRuntimeBackend["generateSessionTitle"],
): PiRuntimeBackend {
  return {
    listModels: async (): Promise<ModelSummary[]> => [],
    listCommands: async () => [],
    listSessions: async () => [],
    createSession: async () => session,
    openSession: async () => session,
    findModel: () => undefined,
    generateSessionTitle,
    deleteSession: async () => undefined,
  };
}

describe("PiRuntimeGateway 提示词刷新", () => {
  it("资源加载器 reload 时读取最新的动态提示词快照", async () => {
    let prompts = ["第一版提示词"];
    const loader = createWorkspaceResourceLoader("/tmp", "/tmp", [], () => prompts);

    await loader.reload();
    expect(loader.getAppendSystemPrompt()).toEqual(["第一版提示词"]);

    prompts = ["第二版提示词"];
    await loader.reload();
    expect(loader.getAppendSystemPrompt()).toEqual(["第二版提示词"]);
  });

  it("提示词被外部更新时立即 reload 空闲会话", async () => {
    const session = createSession();
    const refreshSessionContext = vi.fn(async () => undefined);
    const gateway = createPiRuntimeGateway(createBackend(session), { refreshSessionContext });
    await gateway.createSession();

    await gateway.refreshPromptContext?.();

    expect(refreshSessionContext).toHaveBeenCalledOnce();
    expect(session.reload).toHaveBeenCalledOnce();
    gateway.dispose();
  });

  it("生成中更新提示词，在本轮结束后才 reload 会话", async () => {
    const deferred = createDeferred();
    const session = createSession(() => deferred.promise);
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();
    await gateway.startPrompt("session-1", "正在执行");

    await gateway.refreshPromptContext?.();
    expect(session.reload).not.toHaveBeenCalled();

    deferred.resolve();
    await vi.waitFor(() => expect(session.reload).toHaveBeenCalledOnce());
    gateway.dispose();
  });

  it("首轮完成后仅用用户原文和助手文本生成一次会话标题", async () => {
    const messages: unknown[] = [];
    const model = { provider: "openai", id: "gpt-5" };
    const session = createSession(async () => {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "已完成附件分析。" }, { type: "image", data: "不应进入标题" }],
      });
    }, messages, model);
    const generateSessionTitle = vi.fn(async () => "分析附件中的设计问题");
    const gateway = createPiRuntimeGateway(createBackend(session, generateSessionTitle));
    const events: string[] = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event.type));

    await gateway.startPrompt("session-1", "包含引用和附件的运行时提示词", "请分析这张设计图");
    await vi.waitFor(() => expect(events).toContain("completed"));

    expect(generateSessionTitle).toHaveBeenCalledWith(model, "请分析这张设计图", "已完成附件分析。");
    expect(session.setSessionName).toHaveBeenCalledWith("分析附件中的设计问题");
    expect(events).toEqual(expect.arrayContaining(["session_renamed", "completed"]));
    expect(events.indexOf("session_renamed")).toBeLessThan(events.indexOf("completed"));

    await gateway.startPrompt("session-1", "第二轮运行时提示词", "第二轮用户原文");
    await vi.waitFor(() => expect(events.filter((type) => type === "completed")).toHaveLength(2));
    expect(generateSessionTitle).toHaveBeenCalledOnce();
    gateway.dispose();
  });

  it("标题生成失败时仍正常完成首轮对话", async () => {
    const session = createSession();
    const generateSessionTitle = vi.fn(async () => { throw new Error("模型不可用"); });
    const gateway = createPiRuntimeGateway(createBackend(session, generateSessionTitle));
    const events: string[] = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event.type));

    await gateway.startPrompt("session-1", "运行时提示词", "用户原文");
    await vi.waitFor(() => expect(events).toContain("completed"));

    expect(session.setSessionName).not.toHaveBeenCalled();
    expect(events).not.toContain("session_renamed");
    gateway.dispose();
  });
});
