// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  createPiRuntimeGateway,
  createWorkspaceResourceLoader,
  getGlobalDefaultModel,
  resolveTitleGenerationRequest,
  type ModelSummary,
  type PiRuntimeBackend,
  type PiSessionAdapter,
} from "./pi-runtime";

/** 创建受测试控制的异步值。 */
function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
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
    const deferred = createDeferred<void>();
    const session = createSession(() => deferred.promise);
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.createSession();
    await gateway.startPrompt("session-1", "正在执行");

    await gateway.refreshPromptContext?.();
    expect(session.reload).not.toHaveBeenCalled();

    deferred.resolve(undefined);
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
    await vi.waitFor(() => expect(session.setSessionName).toHaveBeenCalledWith("分析附件中的设计问题"));
    expect(events).toEqual(expect.arrayContaining(["session_renamed", "completed"]));
    expect(events.indexOf("completed")).toBeLessThan(events.indexOf("session_renamed"));

    await gateway.startPrompt("session-1", "第二轮运行时提示词", "第二轮用户原文");
    await vi.waitFor(() => expect(events.filter((type) => type === "completed")).toHaveLength(2));
    expect(generateSessionTitle).toHaveBeenCalledOnce();
    gateway.dispose();
  });

  it("首轮完成不等待后台标题，标题完成后再重命名", async () => {
    const title = createDeferred<string>();
    const messages: unknown[] = [];
    const model = { provider: "openai", id: "gpt-5" };
    const session = createSession(async () => {
      messages.push({ role: "assistant", content: [{ type: "text", text: "首轮回答" }] });
    }, messages, model);
    const gateway = createPiRuntimeGateway(createBackend(session, () => title.promise));
    const events: string[] = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event.type));

    await gateway.startPrompt("session-1", "运行时提示词", "用户原文");
    await vi.waitFor(() => expect(events).toContain("completed"), { timeout: 200 });
    expect(events).not.toContain("session_renamed");

    title.resolve("后台标题");
    await vi.waitFor(() => expect(events).toContain("session_renamed"));
    expect(session.setSessionName).toHaveBeenCalledWith("后台标题");
    expect(events.indexOf("completed")).toBeLessThan(events.indexOf("session_renamed"));
    gateway.dispose();
  });

  it("后台标题返回前被手动命名时不覆盖名称", async () => {
    const title = createDeferred<string>();
    const session = createSession();
    const onSessionTitleGenerated = vi.fn();
    const gateway = createPiRuntimeGateway(createBackend(session, () => title.promise), { onSessionTitleGenerated });
    await gateway.createSession();

    await gateway.startPrompt("session-1", "运行时提示词", "用户原文");
    await vi.waitFor(() => expect(session.isStreaming).toBe(false));
    await gateway.renameSession("session-1", "人工标题");

    title.resolve("自动标题");
    await vi.waitFor(() => expect(onSessionTitleGenerated).toHaveBeenCalledOnce());
    expect(session.setSessionName).toHaveBeenCalledWith("人工标题");
    expect(session.setSessionName).not.toHaveBeenCalledWith("自动标题");
    expect(onSessionTitleGenerated).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped" }));
    gateway.dispose();
  });

  it("后续运行结束前不写入首轮自动标题，也不绑定后续 Run", async () => {
    const title = createDeferred<string>();
    const secondPrompt = createDeferred<void>();
    const messages: unknown[] = [];
    let promptCount = 0;
    const session = createSession(async () => {
      promptCount += 1;
      if (promptCount === 1) {
        messages.push({ role: "assistant", content: [{ type: "text", text: "首轮回答" }] });
        return;
      }
      await secondPrompt.promise;
    }, messages, { provider: "openai", id: "gpt-5" });
    const gateway = createPiRuntimeGateway(createBackend(session, () => title.promise));
    const events: Array<{ type: string; runId?: string }> = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event));

    await gateway.startPrompt("session-1", "首轮运行时提示词", "首轮用户原文");
    await vi.waitFor(() => expect(events.map((event) => event.type)).toContain("completed"));
    await gateway.startPrompt("session-1", "第二轮运行时提示词", "第二轮用户原文");
    await vi.waitFor(() => expect(events.filter((event) => event.type === "run_started")).toHaveLength(2));

    title.resolve("首轮自动标题");
    await title.promise;
    await Promise.resolve();
    expect(session.setSessionName).not.toHaveBeenCalledWith("首轮自动标题");

    secondPrompt.resolve(undefined);
    await vi.waitFor(() => expect(session.setSessionName).toHaveBeenCalledWith("首轮自动标题"));
    const renamed = events.find((event) => event.type === "session_renamed");
    expect(renamed?.runId).toBeUndefined();
    gateway.dispose();
  });

  it("运行时销毁后不发布后台标题事件或日志回调", async () => {
    const title = createDeferred<string>();
    const session = createSession();
    const onSessionTitleGenerated = vi.fn();
    const generateSessionTitle = vi.fn(() => title.promise);
    const gateway = createPiRuntimeGateway(createBackend(session, generateSessionTitle), { onSessionTitleGenerated });
    await gateway.createSession();
    await gateway.startPrompt("session-1", "运行时提示词", "用户原文");
    await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledOnce());

    gateway.dispose();
    title.resolve("已销毁标题");
    await title.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(session.setSessionName).not.toHaveBeenCalled();
    expect(onSessionTitleGenerated).not.toHaveBeenCalled();
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

  it("自动标题超过五十个字符时只保存前五十个字符", async () => {
    const session = createSession();
    const generatedTitle = "会话标题".repeat(20);
    const gateway = createPiRuntimeGateway(createBackend(session, async () => generatedTitle));
    await gateway.createSession();

    await gateway.startPrompt("session-1", "运行时提示词", "用户原文");
    await vi.waitFor(() => expect(session.setSessionName).toHaveBeenCalledOnce());

    expect(session.setSessionName).toHaveBeenCalledWith([...generatedTitle].slice(0, 50).join(""));
    gateway.dispose();
  });
});

describe("标题生成模型策略", () => {
  const sessionModel = { provider: "OpenAI", id: "chat", reasoning: true };
  const systemModel = { provider: "OpenAI", id: "system", reasoning: true };
  const customModel = { provider: "OpenAI", id: "title", reasoning: true };
  const modelsById: Record<string, unknown> = {
    "OpenAI:system": systemModel,
    "OpenAI:title": customModel,
  };
  const findModel = vi.fn((provider: string, id: string) => modelsById[`${provider}:${id}`]);

  it("未配置时使用会话实际模型并关闭思考", () => {
    expect(resolveTitleGenerationRequest(sessionModel, undefined, undefined, { provider: "OpenAI", id: "system" }, findModel))
      .toEqual({ model: sessionModel, reasoning: "off" });
  });

  it("使用系统默认或单独模型，并按 Agent 思考级别生成参数", () => {
    expect(resolveTitleGenerationRequest(sessionModel, {
      modelSource: "system-default",
      thinkingEnabled: true,
    }, undefined, { provider: "OpenAI", id: "system" }, findModel))
      .toEqual({ model: systemModel, reasoning: "medium" });
    expect(resolveTitleGenerationRequest(sessionModel, {
      modelSource: "custom",
      model: { provider: "OpenAI", id: "title" },
      thinkingEnabled: true,
    }, "high", { provider: "OpenAI", id: "system" }, findModel))
      .toEqual({ model: customModel, reasoning: "high" });
  });

  it("目标模型不支持思考或不存在时安全降级", () => {
    expect(resolveTitleGenerationRequest({ provider: "OpenAI", id: "plain", reasoning: false }, {
      modelSource: "session",
      thinkingEnabled: true,
    }, "high", undefined, findModel))
      .toEqual({ model: { provider: "OpenAI", id: "plain", reasoning: false }, reasoning: "off" });
    expect(resolveTitleGenerationRequest(sessionModel, {
      modelSource: "system-default",
      thinkingEnabled: false,
    }, undefined, undefined, findModel)).toBeUndefined();
  });
});

describe("标题系统默认模型", () => {
  it("只读取 Pi 全局设置，不继承 Agent 工作目录的项目设置", () => {
    const settingsManager = {
      getGlobalSettings: () => ({ defaultProvider: "global-provider", defaultModel: "global-model" }),
      getDefaultProvider: () => "project-provider",
      getDefaultModel: () => "project-model",
    };

    expect(getGlobalDefaultModel(settingsManager)).toEqual({ provider: "global-provider", id: "global-model" });
  });
});
