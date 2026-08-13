// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createEditTool, createReadTool, createWriteTool, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MODEL_REQUEST_FAILED_MESSAGE,
  MODEL_RESPONSE_TRUNCATED_MESSAGE,
} from "../shared/assistant-run-outcome";
import {
  createPiRuntimeGateway,
  createWorkspaceResourceLoader,
  getGlobalDefaultModel,
  resolveTitleGenerationRequest,
  type ChatEvent,
  type ModelSummary,
  type PiRuntimeBackend,
  type PiSessionAdapter,
} from "./pi-runtime";
import type { RunCheckpoint } from "./runtime/checkpoint-store";
import { SearchRunState } from "./web-research/search-run-state";
import type { ThinkingLevel } from "../shared/configuration-contracts";

const noRetrieval = {
  knowledgeSearch: false,
  knowledgeRead: false,
  webSearch: false,
  webRead: false,
};

/** 创建受测试控制的异步值。 */
function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 以最小实现模拟 SDK 会话。 */
function createSession(
  prompt: () => Promise<void> = async () => undefined,
  messages: unknown[] = [],
  model: unknown = undefined,
  initialThinkingLevel: ThinkingLevel = "medium",
): PiSessionAdapter & { setSessionName: ReturnType<typeof vi.fn> } {
  let thinkingLevel = initialThinkingLevel;
  return {
    sessionId: "session-1",
    sessionFile: undefined,
    messages,
    model,
    get thinkingLevel() {
      return thinkingLevel;
    },
    availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
    isStreaming: false,
    subscribe: () => () => undefined,
    prompt,
    abort: async () => undefined,
    setModel: async () => undefined,
    setThinkingLevel: vi.fn((level: ThinkingLevel) => { thinkingLevel = level; }),
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
  it("在快照中返回会话真实思考深度并发布切换事件", async () => {
    const session = createSession(undefined, [], { provider: "openai", id: "gpt", name: "GPT" });
    const gateway = createPiRuntimeGateway(createBackend(session));
    const events: ChatEvent[] = [];
    const initial = await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event));

    expect(initial.thinkingLevel).toBe("medium");
    await gateway.setThinkingLevel("session-1", "high");

    expect(session.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(events).toContainEqual(expect.objectContaining({
      type: "thinking_level_changed",
      thinkingLevel: "high",
    }));
    await expect(gateway.openSession("session-1")).resolves.toMatchObject({ thinkingLevel: "high" });
    gateway.dispose();
  });

  it("切换模型导致 SDK 校正深度时在模型事件后发布最终深度", async () => {
    const session = createSession(undefined, [], { provider: "openai", id: "reasoner", name: "Reasoner" }, "max");
    session.setModel = vi.fn(async () => { session.setThinkingLevel("high"); });
    const backend = createBackend(session);
    backend.findModel = () => ({ provider: "openai", id: "compact", name: "Compact", reasoning: true });
    const gateway = createPiRuntimeGateway(backend);
    const events: ChatEvent[] = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event));

    await gateway.setModel("session-1", "openai", "compact");

    const changes = events.filter((event) => event.type !== "snapshot");
    expect(changes.map((event) => event.type)).toEqual(["model_changed", "thinking_level_changed"]);
    expect(changes[1]).toMatchObject({ thinkingLevel: "high" });
    gateway.dispose();
  });

  it("会话文本搜索固定 Agent 作用域并优先读取已打开的当前分支", async () => {
    const messages = [{ role: "assistant", content: "needle 实时分支", __piEntryId: "assistant-live" }];
    const session = createSession(undefined, messages);
    session.navigateTree = vi.fn(async () => ({ cancelled: false }));
    const backend = createBackend(session);
    backend.listSessions = async () => [{
      id: "session-1",
      path: "/managed/session-1.jsonl",
      name: "测试会话",
      created: "2026-08-13T00:00:00.000Z",
      modified: "2026-08-13T01:00:00.000Z",
      messageCount: 1,
      firstMessage: "首条消息",
    }];
    const sessionMetadataStore = {
      listIdsByAgent: vi.fn(async (agentId: string) => agentId === "agent-a" ? ["session-1"] : []),
      listArchivedIds: vi.fn(async () => []),
      isArchived: vi.fn(async () => false),
    };
    const readPersistedBranch = vi.fn(async () => [
      { role: "assistant", content: "needle 持久化旧分支", __piEntryId: "assistant-old" },
    ]);
    const gateway = createPiRuntimeGateway(backend, {
      sessionMetadataStore,
      sessionText: { agentId: "agent-a", readPersistedBranch },
    } as never);
    await gateway.createSession();

    const first = await gateway.searchSessionText!({ query: "needle" });
    expect(first.hits).toMatchObject([{ entryId: "assistant-live", sessionId: "session-1" }]);
    expect(readPersistedBranch).not.toHaveBeenCalled();

    messages.splice(0, messages.length, {
      role: "assistant",
      content: "needle 新分支",
      __piEntryId: "assistant-new",
    });
    const snapshot = await gateway.openSession("session-1");
    await gateway.navigateTree!("session-1", "assistant-new");
    const refreshed = await gateway.searchSessionText!({ query: "needle" });
    expect(refreshed.hits).toMatchObject([{ entryId: "assistant-new" }]);
    expect(snapshot.id).toBe("session-1");
    gateway.dispose();
  });

  it("快照只返回当前分支最近页并用稳定 token 加载上一页", async () => {
    const messages = Array.from({ length: 25 }, (_, index) => {
      const number = index + 1;
      return [
        { role: "user", content: `question-${number}`, __piEntryId: `user-${number}` },
        {
          role: "toolResult",
          content: [{ type: "image", data: "aGVsbG8=" }],
          __piEntryId: `tool-${number}`,
        },
        { role: "assistant", content: `answer-${number}`, __piEntryId: `assistant-${number}` },
      ];
    }).flat();
    const session = createSession(undefined, messages) as PiSessionAdapter & { branchLeafId: string };
    Object.defineProperty(session, "branchLeafId", { get: () => "assistant-25" });
    const gateway = createPiRuntimeGateway(createBackend(session));

    const latest = await gateway.createSession();
    expect(latest.history).toMatchObject({ startEntryId: "user-6", turnCount: 20, hasMoreBefore: true, hasMoreAfter: false });
    expect(latest.messages[1]).toMatchObject({ content: [{ data: "<IMAGE_BASE64>" }] });

    const previous = await gateway.loadHistoryPage!("session-1", "user-6", latest.history.branchToken);
    expect(previous.history).toMatchObject({ startEntryId: "user-1", turnCount: 5, hasMoreBefore: false, hasMoreAfter: true });
    expect((gateway as unknown as Record<string, unknown>).loadHistoryTarget).toBeTypeOf("function");
    expect((gateway as unknown as Record<string, unknown>).loadHistoryPageAfter).toBeTypeOf("function");
    const target = await gateway.loadHistoryTarget!("session-1", "assistant-10", latest.history.branchToken);
    expect(target).toMatchObject({
      targetEntryId: "assistant-10",
      history: { startEntryId: "user-1", endEntryId: "assistant-20", hasMoreAfter: true },
    });
    const newer = await gateway.loadHistoryPageAfter!("session-1", "assistant-20", latest.history.branchToken);
    expect(newer.history).toMatchObject({
      startEntryId: "user-21",
      endEntryId: "assistant-25",
      hasMoreAfter: false,
      turnCount: 5,
    });
    await expect(gateway.loadHistoryTarget!("session-1", "assistant-10", "stale-token"))
      .rejects.toMatchObject({ code: "SESSION_BRANCH_CHANGED" });
    await expect(gateway.loadHistoryPage!("session-1", "user-6", "stale-token")).rejects.toMatchObject({ code: "SESSION_HISTORY_STALE" });
    gateway.dispose();
  });

  it("成功切换树分支后轮换分页 token", async () => {
    const session = createSession();
    session.navigateTree = vi.fn(async () => ({ cancelled: false }));
    const gateway = createPiRuntimeGateway(createBackend(session));
    const initial = await gateway.createSession();

    const navigated = await gateway.navigateTree?.("session-1", "user-old");

    expect(navigated?.snapshot.history.branchToken).not.toBe(initial.history.branchToken);
    gateway.dispose();
  });

  it("资源加载器在每个 Run 读取最新 Agent 提示词上下文", async () => {
    let role = "第一版提示词";
    const resolveAgentPromptContext = vi.fn(async () => ({
      directory: "/data/app/agents/agent-a",
      paths: {
        role: "/data/app/agents/agent-a/ROLE.md",
        behavior: "/data/app/agents/agent-a/BEHAVIOR.md",
        rules: "/data/app/agents/agent-a/RULES.md",
        user: "/data/app/agents/agent-a/USER.md",
        bootsharp: "/data/app/agents/agent-a/BOOTSHARP.md",
      },
      instructions: { role, behavior: "", rules: "", user: "" },
      bootsharp: "",
    }));
    const loader = createWorkspaceResourceLoader(
      "/tmp",
      "/tmp",
      [],
      noRetrieval,
      new SearchRunState(),
      resolveAgentPromptContext,
    );
    await loader.reload();
    const loaded = loader.getExtensions();
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, "/tmp", {} as never, {} as never);

    const first = await runner.emitBeforeAgentStart("第一轮", undefined, "Old\n\nAvailable tools:\n- read", {} as never);
    role = "第二版提示词";
    const second = await runner.emitBeforeAgentStart("第二轮", undefined, "Old\n\nAvailable tools:\n- read", {} as never);

    expect(first?.systemPrompt).toContain("第一版提示词");
    expect(second?.systemPrompt).toContain("第二版提示词");
    expect(second?.systemPrompt).not.toContain("第一版提示词");
    expect(resolveAgentPromptContext).toHaveBeenCalledTimes(2);
  });

  it("Pi 原生 write 可通过绝对路径把 BOOTSHARP 写为空内容", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-native-write-"));
    const cwd = join(root, "workspace");
    const bootsharp = join(root, "app", "agents", "agent-a", "BOOTSHARP.md");
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(dirname(bootsharp), { recursive: true }),
    ]);
    await writeFile(bootsharp, "初始化引导", "utf8");
    try {
      const tool = createWriteTool(cwd);
      await tool.execute(
        "write-bootsharp",
        { path: bootsharp, content: "" },
        undefined,
        undefined,
      );

      await expect(readFile(bootsharp, "utf8")).resolves.toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Pi 原生 read 与 edit 可通过绝对路径维护长期提示词", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-native-prompt-tools-"));
    const cwd = join(root, "workspace");
    const role = join(root, "app", "agents", "agent-a", "ROLE.md");
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(dirname(role), { recursive: true }),
    ]);
    await writeFile(role, "研究助手", "utf8");
    try {
      const readTool = createReadTool(cwd);
      const editTool = createEditTool(cwd);

      await expect(readTool.execute(
        "read-role",
        { path: role },
        undefined,
        undefined,
      )).resolves.toBeDefined();
      await editTool.execute(
        "edit-role",
        { path: role, edits: [{ oldText: "研究助手", newText: "代码审查助手" }] },
        undefined,
        undefined,
      );

      await expect(readFile(role, "utf8")).resolves.toBe("代码审查助手");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("资源加载器注册提示词注入与搜索断路扩展", async () => {
    const loader = createWorkspaceResourceLoader("/tmp", "/tmp", [], {
      knowledgeSearch: false,
      knowledgeRead: false,
      webSearch: true,
      webRead: false,
    });

    await loader.reload();

    expect(loader.getExtensions().extensions.map(({ path }) => path)).toEqual([
      "<inline:bug-paw-system-prompt-injection>",
      "<inline:bug-paw-search-run-circuit>",
    ]);
    expect(loader.getExtensions().errors).toEqual([]);
  });

  it("未授权 web_search 时不注册搜索断路扩展", async () => {
    const loader = createWorkspaceResourceLoader("/tmp", "/tmp", [], {
      knowledgeSearch: false,
      knowledgeRead: false,
      webSearch: false,
      webRead: true,
    });

    await loader.reload();

    expect(loader.getExtensions().extensions.map(({ path }) => path)).toEqual([
      "<inline:bug-paw-system-prompt-injection>",
    ]);
  });

  it("通过 Pi ExtensionRunner 在新 Run 重置搜索断路且不影响其他工具", async () => {
    const loader = createWorkspaceResourceLoader("/tmp", "/tmp", [], {
      knowledgeSearch: false,
      knowledgeRead: false,
      webSearch: true,
      webRead: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, "/tmp", {} as never, {} as never);
    const searchCall = { type: "tool_call" as const, toolCallId: "search-1", toolName: "web_search", input: { query: "测试" } };

    await runner.emitBeforeAgentStart("第一轮", undefined, "identity\n\nAvailable tools:\n", {} as never);
    expect(await runner.emitToolCall(searchCall)).toBeUndefined();
    await runner.emitToolResult({
      type: "tool_result",
      toolCallId: "search-1",
      toolName: "web_search",
      input: searchCall.input,
      content: [{ type: "text", text: JSON.stringify({ status: "error", error: { code: "SEARCH_PROVIDERS_UNAVAILABLE", retryable: false } }) }],
      details: {},
      isError: false,
    });

    const blocked = await runner.emitToolCall({ ...searchCall, toolCallId: "search-2" });
    expect(blocked).toMatchObject({ block: true });
    expect(blocked?.terminate).toBeUndefined();
    expect(JSON.parse(blocked?.reason ?? "")).toMatchObject({ error: { code: "SEARCH_PROVIDERS_UNAVAILABLE", retryable: false } });
    expect(await runner.emitToolCall({ ...searchCall, toolCallId: "read-1", toolName: "web_read", input: { url: "https://example.com" } })).toBeUndefined();

    await runner.emitBeforeAgentStart("第二轮", undefined, "identity\n\nAvailable tools:\n", {} as never);
    expect(await runner.emitToolCall({ ...searchCall, toolCallId: "search-3" })).toBeUndefined();
  });

  it("在工具参数生成时发布节流进度且不转发原始正文", async () => {
    let listener: Parameters<PiSessionAdapter["subscribe"]>[0] = () => undefined;
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const toolCall = {
      type: "toolCall",
      id: "call-1",
      name: "write",
      arguments: { path: "src/app.ts", content: "完整内容" },
    };
    const assistantMessage = { role: "assistant", content: [{ ...toolCall, arguments: { path: "src/app.ts", content: "大文件正文" } }] };
    const session = createSession(async () => {
      listener({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: assistantMessage },
      } as never);
      listener({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "",
          partial: assistantMessage,
        },
      } as never);
      listener({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "x".repeat(512),
          partial: assistantMessage,
        },
      } as never);
      now = 300;
      listener({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "y".repeat(200),
          partial: assistantMessage,
        },
      } as never);
      now = 600;
      listener({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "z".repeat(200),
          partial: assistantMessage,
        },
      } as never);
      listener({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "a".repeat(512),
          partial: assistantMessage,
        },
      } as never);
      listener({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall, partial: assistantMessage },
      } as never);
    });
    session.subscribe = (next) => {
      listener = next;
      return () => undefined;
    };
    const gateway = createPiRuntimeGateway(createBackend(session));
    const events: Array<{ type: string }> = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event));

    await gateway.startPrompt("session-1", "生成文件", "生成文件");
    await vi.waitFor(() => expect(events.some((event) => event.type === "completed")).toBe(true));

    const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
    expect(toolEvents).toEqual([
      expect.objectContaining({ type: "tool_preparing", callId: "call-1", toolName: "write" }),
      expect.objectContaining({
        type: "tool_parameters_streaming",
        callId: "call-1",
        toolName: "write",
        generatedBytes: 512,
        path: "src/app.ts",
      }),
      expect.objectContaining({
        type: "tool_parameters_streaming",
        callId: "call-1",
        toolName: "write",
        generatedBytes: 912,
        path: "src/app.ts",
      }),
      expect.objectContaining({
        type: "tool_parameters_streaming",
        callId: "call-1",
        toolName: "write",
        generatedBytes: 1424,
        path: "src/app.ts",
      }),
      expect.objectContaining({ type: "tool_prepared", callId: "call-1", toolName: "write", args: toolCall.arguments }),
    ]);
    expect(JSON.stringify(toolEvents)).not.toContain("大文件正文");
    gateway.dispose();
    dateNow.mockRestore();
  });

  it("最终合并工具第三次连续空参数事件终止当前 Run 并保留会话", async () => {
    let listener: Parameters<PiSessionAdapter["subscribe"]>[0] = () => undefined;
    let aborted = false;
    const abort = vi.fn(() => {
      aborted = true;
      return Promise.resolve();
    });
    const session = createSession(async () => {
      for (let count = 1; count <= 3; count += 1) {
        listener({
          type: "tool_execution_start",
          toolCallId: `call-${count}`,
          toolName: "session_list",
          args: {},
        } as never);
        listener({
          type: "tool_execution_end",
          toolCallId: `call-${count}`,
          toolName: "session_list",
          result: { content: [{ type: "text", text: aborted ? "Operation aborted" : "参数校验失败" }] },
          isError: true,
        } as never);
      }
    });
    session.subscribe = (next) => {
      listener = next;
      return () => undefined;
    };
    session.abort = abort;
    const diagnostics: Array<{ count: number; action: string }> = [];
    const gateway = createPiRuntimeGateway(createBackend(session), {
      toolCallCircuitBreakerTools: () => [{
        name: "session_list",
        label: "Session List",
        description: "测试工具",
        parameters: {
          type: "object",
          properties: { action: { type: "string" } },
          required: ["action"],
        },
        execute: vi.fn(),
      } as never],
      onToolCallCircuitBreak: (event) => diagnostics.push(event),
    });
    const events: string[] = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event.type));

    await gateway.startPrompt("session-1", "运行时提示词", "用户原文");
    await vi.waitFor(() => expect(events).toContain("aborted"));

    expect(abort).toHaveBeenCalledOnce();
    expect(events).not.toContain("completed");
    expect(diagnostics.map(({ count, action }) => ({ count, action }))).toEqual([
      { count: 1, action: "allowed" },
      { count: 2, action: "allowed" },
      { count: 3, action: "terminated" },
    ]);
    expect((await gateway.openSession("session-1")).id).toBe("session-1");
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

  it("运行时销毁后不记录后台标题失败", async () => {
    const title = createDeferred<string>();
    const session = createSession();
    const onBackgroundError = vi.fn();
    const onSessionTitleGenerated = vi.fn();
    const generateSessionTitle = vi.fn(() => title.promise);
    const gateway = createPiRuntimeGateway(createBackend(session, generateSessionTitle), { onBackgroundError, onSessionTitleGenerated });
    await gateway.createSession();
    await gateway.startPrompt("session-1", "运行时提示词", "用户原文");
    await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledOnce());

    gateway.dispose();
    title.reject(new Error("标题服务不可用"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onBackgroundError).not.toHaveBeenCalled();
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

  it("prompt 以值语义返回模型错误时发布安全失败并保存一致终态", async () => {
    const messages: unknown[] = [];
    const session = createSession(async () => {
      messages.push({
        role: "assistant",
        stopReason: "error",
        content: [],
        errorMessage: "Bearer clearly-fake-token vendor-body",
      });
    }, messages, { provider: "openai", id: "gpt-5" });
    const generateSessionTitle = vi.fn(async () => "不应生成");
    const onRunFinished = vi.fn(async () => undefined);
    const checkpointStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async (_checkpoint: RunCheckpoint) => undefined),
      remove: vi.fn(async () => undefined),
      markInterrupted: vi.fn(async () => undefined),
    };
    const gateway = createPiRuntimeGateway(createBackend(session, generateSessionTitle), {
      checkpointStore,
      checkpointThrottleMs: 0,
      onRunFinished,
    });
    const events: ChatEvent[] = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event));

    await gateway.startPrompt("session-1", "运行时提示词", "用户原文");
    await vi.waitFor(() => expect(events.some((event) => event.type === "error")).toBe(true));

    expect(events.filter((event) => ["completed", "aborted", "error"].includes(event.type)).map((event) => event.type))
      .toEqual(["error"]);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: "AGENT_EXECUTION_FAILED",
      message: MODEL_REQUEST_FAILED_MESSAGE,
    });
    const terminalSnapshot = [...events].reverse().find((event) => event.type === "snapshot"
      && JSON.stringify(event.messages).includes(MODEL_REQUEST_FAILED_MESSAGE));
    expect(terminalSnapshot?.type).toBe("snapshot");
    expect(JSON.stringify(terminalSnapshot)).not.toContain("clearly-fake-token");
    expect(JSON.stringify(terminalSnapshot)).not.toContain("vendor-body");
    expect(events.indexOf(terminalSnapshot!)).toBeLessThan(events.findIndex((event) => event.type === "error"));
    await vi.waitFor(() => expect(onRunFinished).toHaveBeenCalledWith(expect.objectContaining({ status: "error" })));
    await vi.waitFor(() => expect(checkpointStore.save.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "error",
      error: MODEL_REQUEST_FAILED_MESSAGE,
    }));
    expect(generateSessionTitle).not.toHaveBeenCalled();
    gateway.dispose();
  });

  it("只按最终 Assistant 判断自动重试结果", async () => {
    const messages: unknown[] = [];
    const session = createSession(async () => {
      messages.push(
        { role: "assistant", stopReason: "error", errorMessage: "intermediate failure" },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "最终成功" }] },
      );
    }, messages);
    const gateway = createPiRuntimeGateway(createBackend(session));
    const events: ChatEvent[] = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event));

    await gateway.startPrompt("session-1", "运行时提示词");
    await vi.waitFor(() => expect(events.some((event) => event.type === "completed")).toBe(true));

    expect(events.some((event) => event.type === "error")).toBe(false);
    gateway.dispose();
  });

  it("按 Assistant 中止状态结束 Run", async () => {
    const messages: unknown[] = [];
    const session = createSession(async () => {
      messages.push({ role: "assistant", stopReason: "aborted", content: [] });
    }, messages);
    const onRunFinished = vi.fn(async () => undefined);
    const gateway = createPiRuntimeGateway(createBackend(session), { onRunFinished });
    const events: ChatEvent[] = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event));

    await gateway.startPrompt("session-1", "运行时提示词");
    await vi.waitFor(() => expect(events.some((event) => event.type === "aborted")).toBe(true));

    expect(events.some((event) => event.type === "completed")).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(false);
    await vi.waitFor(() => expect(onRunFinished).toHaveBeenCalledWith(expect.objectContaining({ status: "aborted" })));
    gateway.dispose();
  });

  it("长度截断保留回答并以 completed 结束", async () => {
    const messages: unknown[] = [];
    const session = createSession(async () => {
      messages.push({
        role: "assistant",
        stopReason: "length",
        content: [{ type: "text", text: "部分回答" }],
        errorMessage: "untrusted truncation detail",
      });
    }, messages, { provider: "openai", id: "gpt-5" });
    const generateSessionTitle = vi.fn(async () => "截断回答");
    const gateway = createPiRuntimeGateway(createBackend(session, generateSessionTitle));
    const events: ChatEvent[] = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event));

    await gateway.startPrompt("session-1", "运行时提示词", "用户原文");
    await vi.waitFor(() => expect(events.some((event) => event.type === "completed")).toBe(true));

    const snapshot = [...events].reverse().find((event) => event.type === "snapshot"
      && JSON.stringify(event.messages).includes(MODEL_RESPONSE_TRUNCATED_MESSAGE));
    expect(snapshot?.type).toBe("snapshot");
    expect(JSON.stringify(snapshot)).toContain("部分回答");
    expect(events.indexOf(snapshot!)).toBeLessThan(events.findIndex((event) => event.type === "completed"));
    expect(events.some((event) => event.type === "error")).toBe(false);
    await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledWith(
      { provider: "openai", id: "gpt-5" },
      "用户原文",
      "部分回答",
    ));
    gateway.dispose();
  });

  it("prompt reject 继续走异常终态", async () => {
    const session = createSession(async () => { throw new Error("适配器故障"); });
    const onRunFinished = vi.fn(async () => undefined);
    const gateway = createPiRuntimeGateway(createBackend(session), { onRunFinished });
    const events: ChatEvent[] = [];
    await gateway.createSession();
    gateway.subscribe("session-1", (event) => events.push(event));

    await gateway.startPrompt("session-1", "运行时提示词");
    await vi.waitFor(() => expect(events.some((event) => event.type === "error")).toBe(true));

    expect(events.some((event) => event.type === "completed")).toBe(false);
    await vi.waitFor(() => expect(onRunFinished).toHaveBeenCalledWith(expect.objectContaining({ status: "error" })));
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
