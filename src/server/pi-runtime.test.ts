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
function createSession(prompt: () => Promise<void> = async () => undefined): PiSessionAdapter & { reload: ReturnType<typeof vi.fn> } {
  return {
    sessionId: "session-1",
    sessionFile: undefined,
    messages: [],
    model: undefined,
    isStreaming: false,
    subscribe: () => () => undefined,
    prompt,
    reload: vi.fn(async () => undefined),
    abort: async () => undefined,
    setModel: async () => undefined,
    setSessionName: () => undefined,
    dispose: () => undefined,
  };
}

/** 创建只提供单会话的运行时后端。 */
function createBackend(session: PiSessionAdapter): PiRuntimeBackend {
  return {
    listModels: async (): Promise<ModelSummary[]> => [],
    listCommands: async () => [],
    listSessions: async () => [],
    createSession: async () => session,
    openSession: async () => session,
    findModel: () => undefined,
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
});
