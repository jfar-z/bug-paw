// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSessionMock, resourceLoaderOptions } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  resourceLoaderOptions: [] as Array<{ extensionFactories?: unknown[] }>,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  DefaultResourceLoader: class {
    constructor(options: { extensionFactories?: unknown[] }) {
      resourceLoaderOptions.push(options);
    }

    async reload() {
      return undefined;
    }
  },
  SettingsManager: {
    create: () => ({
      getGlobalSettings: () => ({}),
      getDefaultProvider: () => "Local",
      getDefaultModel: () => "Qwen3.6-35B-A3B",
    }),
  },
  SessionManager: {
    create: () => sessionManager(),
    inMemory: () => sessionManager(),
    open: () => sessionManager(),
    list: async () => [],
  },
}));

import { createSdkPiRuntimeGateway } from "../../src/server/pi-runtime";

describe("SDK Pi Runtime", () => {
  beforeEach(() => {
    createAgentSessionMock.mockReset();
    resourceLoaderOptions.splice(0);
  });

  it("创建 SDK 会话时传递 Agent 的关闭思考设置", async () => {
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionId: "session-1",
        messages: [],
        model: { provider: "Local", id: "Qwen3.6-35B-A3B", name: "Qwen3.6-35B-A3B" },
        isStreaming: false,
        subscribe: () => () => undefined,
        prompt: async () => undefined,
        reload: async () => undefined,
        abort: async () => undefined,
        setModel: async () => undefined,
        setSessionName: () => undefined,
        dispose: () => undefined,
      },
      extensionsResult: { runtime: { getCommands: () => [] } },
    });
    const modelRuntime = {
      getModel: () => ({ provider: "Local", id: "Qwen3.6-35B-A3B", name: "Qwen3.6-35B-A3B" }),
      getAvailable: async () => [],
    };
    const sessionSearchTool = {
      name: "session_search",
      label: "Session Search",
      description: "测试会话搜索工具",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: vi.fn(),
    };
    const gateway = await createSdkPiRuntimeGateway({
      agentId: "agent-a",
      cwd: "/workspace",
      agentDir: "/agent-data",
      modelRuntime: modelRuntime as never,
      defaultModel: { provider: "Local", id: "Qwen3.6-35B-A3B" },
      defaultThinkingLevel: "off",
      allowedTools: ["session_search"],
      retrievalCapabilities: { knowledgeSearch: false, knowledgeRead: false, webSearch: false, webRead: false },
      createRuntimeTools: () => [sessionSearchTool as never],
    });

    await gateway.listCommands();

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      thinkingLevel: "off",
      tools: ["session_search"],
      customTools: [sessionSearchTool],
    }));
    gateway.dispose();
  });

  it("把 ask_user 终止工具和消息防护一起交给 SDK", async () => {
    createAgentSessionMock.mockResolvedValue(sdkSessionResult());
    const askUserTool = {
      name: "ask_user",
      label: "询问用户",
      description: "测试结构化提问工具",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => ({
        content: [{ type: "text", text: "等待回答" }],
        details: { type: "question_pending" },
        isError: false,
        terminate: true,
      })),
    };
    const gateway = await createSdkPiRuntimeGateway({
      agentId: "agent-a",
      cwd: "/workspace",
      agentDir: "/agent-data",
      modelRuntime: modelRuntime() as never,
      defaultModel: { provider: "Local", id: "Qwen3.6-35B-A3B" },
      allowedTools: ["ask_user"],
      retrievalCapabilities: { knowledgeSearch: false, knowledgeRead: false, webSearch: false, webRead: false },
      createSessionTools: () => [askUserTool as never],
    });

    await gateway.listCommands();

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      tools: ["ask_user"],
      customTools: [askUserTool],
    }));
    await expect(askUserTool.execute()).resolves.toMatchObject({ terminate: true, isError: false });

    const handlers = new Map<string, (event: never) => unknown>();
    const pi = {
      on: vi.fn((event: string, handler: (input: never) => unknown) => handlers.set(event, handler)),
    };
    for (const extension of resourceLoaderOptions.at(-1)?.extensionFactories ?? []) {
      const factory = (extension as { factory?: (api: typeof pi) => void }).factory;
      factory?.(pi);
    }
    const result = handlers.get("message_end")?.({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "请选择" },
          { type: "toolCall", name: "read", id: "call-read" },
          { type: "toolCall", name: "ask_user", id: "call-ask" },
          { type: "text", text: "这段不应保留" },
          { type: "toolCall", name: "write", id: "call-write" },
        ],
      },
    } as never) as { message: { content: unknown[] } };

    expect(result.message.content).toEqual([
      { type: "text", text: "请选择" },
      { type: "toolCall", name: "ask_user", id: "call-ask" },
    ]);
    gateway.dispose();
  });
});

function sessionManager() {
  return {
    getSessionId: () => "session-1",
    getLeafId: () => "leaf-1",
  };
}

function modelRuntime() {
  return {
    getModel: () => ({ provider: "Local", id: "Qwen3.6-35B-A3B", name: "Qwen3.6-35B-A3B" }),
    getAvailable: async () => [],
  };
}

function sdkSessionResult() {
  return {
    session: {
      sessionId: "session-1",
      messages: [],
      model: { provider: "Local", id: "Qwen3.6-35B-A3B", name: "Qwen3.6-35B-A3B" },
      isStreaming: false,
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      reload: async () => undefined,
      abort: async () => undefined,
      setModel: async () => undefined,
      setSessionName: () => undefined,
      dispose: () => undefined,
    },
    extensionsResult: { runtime: { getCommands: () => [] } },
  };
}
