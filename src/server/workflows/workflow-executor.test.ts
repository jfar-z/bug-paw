// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  WorkflowNodeExecutor,
  workflowModelPayload,
} from "./workflow-executor";
import {
  emptyWorkflow,
  newWorkflowNode,
} from "../../shared/workflow-contracts";

/** 协议测试检查最终请求字段，不调用任何真实模型或计费服务。 */
describe("工作流模型参数映射", () => {
  it("OpenAI 采样参数及 JSON 覆盖，默认思考不强制关闭", () => {
    expect(
      workflowModelPayload(
        { model: "m", messages: [], reasoning_effort: "none" },
        "openai-completions",
        {
          temperature: 0.7,
          topP: 0.8,
          frequencyPenalty: 0.2,
          customParameters: { seed: 42, top_p: 0.6 },
        },
      ),
    ).toMatchObject({
      model: "m",
      messages: [],
      top_p: 0.6,
      frequency_penalty: 0.2,
      presence_penalty: 0,
      seed: 42,
    });
    expect(
      workflowModelPayload(
        { reasoning: { effort: "none" } },
        "openai-responses",
        { thinking: "inherit" },
      ),
    ).not.toHaveProperty("reasoning");
    expect(
      workflowModelPayload(
        { reasoning: { effort: "none" } },
        "openai-responses",
        { thinking: "off" },
      ),
    ).toHaveProperty("reasoning.effort", "none");
  });
  it("Google 合并 config，保留系统提示及取消信号；Anthropic 不同时发送温度和 top_p", () => {
    expect(
      workflowModelPayload(
        {
          model: "m",
          contents: [],
          config: {
            systemInstruction: "system",
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
        "google-generative-ai",
        { thinking: "inherit", topP: 0.9, customParameters: { topK: 40 } },
      ),
    ).toEqual({
      model: "m",
      contents: [],
      config: { systemInstruction: "system", topP: 0.9, topK: 40 },
    });
    expect(
      workflowModelPayload(
        { temperature: 0.7, messages: [] },
        "anthropic-messages",
        { topP: 0.8 },
      ),
    ).toEqual({ messages: [], top_p: 0.8 });
    expect(() =>
      workflowModelPayload({}, "openai-responses", { presencePenalty: 1 }),
    ).toThrow("不支持");
  });
});
/** 用会话事件验证先订阅后发送、归档与取消，防止快速完成事件丢失。 */
describe("工作流 Agent 执行", () => {
  function fixture(event: "completed" | "question_pending" = "completed") {
    let listener: (event: unknown) => void = () => {};
    const runtime = {
      createSession: vi.fn(async () => ({ id: "new-session" })),
      openSession: vi.fn(async () => ({ lastEventId: 0 })),
      unarchiveSession: vi.fn(async () => {}),
      archiveSession: vi.fn(async () => {}),
      subscribe: vi.fn((_id, _cursor, fn) => {
        listener = fn;
        return vi.fn();
      }),
      startPrompt: vi.fn(async () => {
        listener({ type: "text_delta", delta: "answer" });
        listener(
          event === "completed"
            ? { type: event }
            : { type: event, question: {} },
        );
        return { status: "running" };
      }),
      abort: vi.fn(async () => {}),
      discardUnassignedSession: vi.fn(),
    };
    const release = vi.fn();
    const executor = new WorkflowNodeExecutor({
      runtimes: { acquire: async () => ({ runtime, release }) },
      assignSession: vi.fn(async () => {}),
      sessionAgent: async () => "a",
      assertSessionRunnable: () => {},
      files: {},
    } as never);
    const node = newWorkflowNode("agent", "agent");
    node.config = {
      agentId: "a",
      sessionMode: "new",
      archiveAfterCompletion: true,
    };
    const ctx = {
      node,
      run: { id: "run", nodes: [] },
      signal: new AbortController().signal,
      progress: vi.fn(async () => {}),
    } as never;
    return { executor, runtime, release, ctx, node };
  }
  it("新建会话快速完成后归档，复用模式不创建新会话", async () => {
    const f = fixture();
    expect(await f.executor.execute(f.ctx, { prompt: "hello" })).toEqual({
      text: "answer",
      files: [],
      sessionId: "new-session",
    });
    expect(f.runtime.archiveSession).toHaveBeenCalledWith("new-session");
    expect(f.release).toHaveBeenCalled();
    f.node.config.sessionMode = "fixed";
    f.node.config.sessionId = "fixed";
    expect(await f.executor.execute(f.ctx, { prompt: "next" })).toMatchObject({
      sessionId: "fixed",
    });
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
  });
  it("人工问题停止运行，释放租约且不归档未完成会话", async () => {
    const f = fixture("question_pending");
    await expect(
      f.executor.execute(f.ctx, { prompt: "hello" }),
    ).rejects.toThrow("人工回答");
    expect(f.runtime.abort).toHaveBeenCalled();
    expect(f.runtime.archiveSession).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalled();
  });
});

/** AIGC 节点覆盖创作接口目录、真实输入映射、产物归属与上游取消。 */
describe("工作流 AIGC 适配", () => {
  function fixture() {
    const item = {
      id: "image",
      name: "图片生成",
      protocol: "openai",
      capability: "text-to-image",
      enabled: true,
      config: { model: "demo", parameters: [] },
    };
    const task = {
      id: "task",
      status: "succeeded",
      assets: [
        {
          id: "asset",
          name: "result.png",
          mediaType: "image/png",
          outputId: "result",
        },
      ],
    };
    const createRun = vi.fn(async () => task),
      get = vi.fn(async () => task),
      cancel = vi.fn(async () => ({
        ...task,
        upstreamCancellation: "cancelled",
      })),
      upload = vi.fn(async () => ({
        assetId: "output",
        name: "result.png",
        mediaType: "image/png",
        size: 6,
      }));
    const executor = new WorkflowNodeExecutor({
      modelRuntime: () => ({ getAvailable: async () => [] }),
      agents: { list: async () => [] },
      interfaces: {
        list: async () => ({ interfaces: [item] }),
        get: async () => item,
      },
      aigcTasks: { createRun, get, cancel },
      aigcAssets: { readOutput: async () => Buffer.from("image") },
      files: { upload },
    } as never);
    const node = newWorkflowNode("aigc", "aigc");
    node.config.interfaceId = item.id;
    node.outputs.push({ name: "output_1", type: "image", multiple: true });
    const controller = new AbortController();
    const ctx = {
      node,
      run: {
        id: "run",
        origin: { agentId: "a", sessionId: "s" },
        nodes: [{ nodeId: "aigc", events: [] }],
      },
      signal: controller.signal,
      progress: vi.fn(async () => {}),
    } as never;
    return {
      executor,
      createRun,
      get,
      cancel,
      upload,
      node,
      ctx,
      controller,
      task,
    };
  }
  it("目录包含可运行接口，执行按输出映射交付文件", async () => {
    const f = fixture();
    expect((await f.executor.catalog()).interfaces[0]).toMatchObject({
      id: "image",
      fields: [{ name: "prompt", type: "string", required: true }],
      outputs: [{ name: "files" }, { name: "output_1", type: "image" }],
    });
    expect(await f.executor.execute(f.ctx, { prompt: "test" })).toMatchObject({
      files: [{ assetId: "output" }],
      output_1: [{ assetId: "output" }],
    });
    expect(f.createRun).toHaveBeenCalledWith({
      interfaceId: "image",
      inputs: { prompt: "test" },
    });
    expect(f.upload.mock.calls[0].at(-1)).toBe("a");
  });
  it("缺少参数不创建任务，取消只传递到本次上游任务", async () => {
    const f = fixture();
    await expect(f.executor.execute(f.ctx, {})).rejects.toThrow("必填");
    expect(f.createRun).not.toHaveBeenCalled();
    f.get.mockImplementation(async () => {
      f.controller.abort();
      return { ...f.task, status: "running" };
    });
    await expect(
      f.executor.execute(f.ctx, { prompt: "test" }),
    ).rejects.toThrow();
    expect(f.cancel).toHaveBeenCalledWith("task");
  });
});
