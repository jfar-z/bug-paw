// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { createAgentSessionMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  DefaultResourceLoader: class {
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
    create: () => ({}),
    inMemory: () => ({}),
    open: () => ({}),
    list: async () => [],
  },
}));

import { createSdkPiRuntimeGateway } from "../../src/server/pi-runtime";

describe("SDK Pi Runtime", () => {
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
    const gateway = await createSdkPiRuntimeGateway({
      cwd: "/workspace",
      agentDir: "/agent-data",
      modelRuntime: modelRuntime as never,
      defaultModel: { provider: "Local", id: "Qwen3.6-35B-A3B" },
      defaultThinkingLevel: "off",
    });

    await gateway.listCommands();

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "off" }));
    gateway.dispose();
  });
});
