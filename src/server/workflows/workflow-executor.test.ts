// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  WorkflowNodeExecutor,
  workflowModelPayload,
  expandReferenceGroups,
  workflowReferenceGroups,
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
      item,
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
  it("枚举目录保留约束，引用按字符串转换真实值，非法值不创建任务", async () => {
    const f = fixture();
    f.item.config.parameters = [
      { name: "steps", type: "enum", enumValues: [10, 20], defaultValue: 10 },
      { name: "enabled", type: "enum", enumValues: [true, false] },
    ] as never;
    const fields = (await f.executor.catalog()).interfaces[0].fields;
    expect(fields.find((field) => field.name === "steps")).toMatchObject({
      enumValues: [10, 20],
      defaultValue: 10,
    });
    f.node.inputs.steps = {
      kind: "reference",
      nodeId: "upstream",
      field: "text",
    };
    f.node.inputs.enabled = {
      kind: "reference",
      nodeId: "upstream",
      field: "flag",
    };
    await f.executor.execute(f.ctx, {
      prompt: "test",
      steps: "20",
      enabled: "false",
    });
    expect(f.createRun).toHaveBeenLastCalledWith({
      interfaceId: "image",
      inputs: { prompt: "test", steps: 20, enabled: false },
    });
    f.createRun.mockClear();
    for (const steps of ["99", {}, [20], null, " 20 "]) {
      await expect(
        f.executor.execute(f.ctx, { prompt: "test", steps }),
      ).rejects.toThrow("参数 steps");
      expect(f.createRun).not.toHaveBeenCalled();
    }
    f.node.inputs.steps = { kind: "literal", value: "20" };
    await expect(
      f.executor.execute(f.ctx, { prompt: "test", steps: "20" }),
    ).rejects.toThrow("枚举");
    expect(f.createRun).not.toHaveBeenCalled();
  });
  it("运行前发现枚举来源选项变化，不启动计费任务", async () => {
    const f = fixture();
    f.item.config.parameters = [
      { name: "steps", type: "enum", enumValues: [10, 20] },
    ] as never;
    const draft = emptyWorkflow();
    draft.nodes.push(f.node);
    draft.nodes[0].outputs[0].enumValues = ["10", "20"];
    draft.nodes[0].outputs[0].enumSource = {
      nodeId: f.node.id,
      field: "steps",
      interfaceId: f.item.id,
    };
    await expect(f.executor.validate(draft as never)).resolves.toBeUndefined();
    draft.nodes[0].outputs[0].enumValues = ["10", "99"];
    await expect(f.executor.validate(draft as never)).rejects.toThrow(
      "枚举定义已变更",
    );
    expect(f.createRun).not.toHaveBeenCalled();
  });
  it("字符串化后有歧义的枚举不猜测目标类型", async () => {
    const f = fixture();
    f.item.config.parameters = [
      { name: "choice", type: "enum", enumValues: [1, "1"] },
    ] as never;
    f.node.inputs.choice = {
      kind: "reference",
      nodeId: "upstream",
      field: "value",
    };
    await expect(
      f.executor.execute(f.ctx, { prompt: "test", choice: "1" }),
    ).rejects.toThrow("无法唯一转换");
    expect(f.createRun).not.toHaveBeenCalled();
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

/** 参考组必须忠实遵循映射顺序，并在上传前拒绝数量和类型错误。 */
describe("参考组数组模式", () => {
  const group = {
    id: "refs",
    label: "参考图片",
    type: "image" as const,
    fields: ["second", "first"],
  };
  const image = { assetId: "one", mediaType: "image/png" };
  it("数组按槽位顺序展开，空数组清空槽位，拆分模式保持原参数", () => {
    const node = newWorkflowNode("aigc", "aigc");
    const inputs = { prompt: "text", first: image, second: image };
    expect(expandReferenceGroups(node, inputs, {}, [group])).toEqual(inputs);
    node.config.referenceGroups = { refs: { mode: "array" } };
    expect(
      expandReferenceGroups(node, inputs, { refs: [image] }, [group]),
    ).toEqual({ prompt: "text", second: image });
    expect(expandReferenceGroups(node, inputs, { refs: [] }, [group])).toEqual({
      prompt: "text",
    });
    expect(expandReferenceGroups(node, inputs, {}, [group])).toEqual({
      prompt: "text",
    });
  });
  it("超长、空元素、非数组、错误媒体类型和失效组都明确拒绝", () => {
    const node = newWorkflowNode("aigc", "aigc");
    node.config.referenceGroups = {
      refs: {
        mode: "array",
        binding: { kind: "reference", nodeId: "input", field: "images" },
      },
    };
    for (const refs of [
      [image, image, image],
      [null],
      image,
      undefined,
      [{ assetId: "x", mediaType: "audio/wav" }],
    ])
      expect(() =>
        expandReferenceGroups(node, {}, { refs }, [group]),
      ).toThrow();
    expect(() => expandReferenceGroups(node, {}, { refs: [] }, [])).toThrow(
      "参考组已变更",
    );
  });
  it("目录公开原始 mappingIds 的顺序，而不是参数列表排列顺序", () => {
    expect(
      workflowReferenceGroups({
        inputMappings: [
          { id: "a", name: "first", type: "image" },
          { id: "b", name: "second", type: "image" },
        ],
        inputGroups: [{ ...group, mappingIds: ["b", "a"] }],
      } as never),
    ).toEqual([group]);
  });
});

/** 真实执行适配器验证数组展开后仍走原始上传、参数映射与任务创建链路。 */
it("ComfyUI 参考数组通过原始字段上传，空数组不上传，错误在计费前暴露", async () => {
  const item = {
    id: "group-interface",
    enabled: true,
    protocol: "comfyui",
    config: { workflowId: "group-workflow" },
  };
  const workflow = {
    nodes: [],
    edges: [],
    outputMappings: [],
    inputMappings: ["left", "right"].map((name) => ({
      id: name,
      name,
      type: "image",
      required: false,
      nodeId: name,
      field: "inputs.image",
    })),
    inputGroups: [
      {
        id: "refs",
        label: "参考图",
        type: "image",
        mappingIds: ["right", "left"],
      },
    ],
  };
  const task = { id: "task", status: "succeeded", assets: [] };
  const createRun = vi.fn(async () => task);
  const saveInput = vi.fn(async (_content, name, mediaType) => ({
    id: name,
    name,
    mediaType,
  }));
  const executor = new WorkflowNodeExecutor({
    interfaces: { get: async () => item },
    aigcWorkflows: { get: async () => ({ workflow }) },
    aigcTasks: { createRun, get: async () => task },
    files: {
      buffer: async (file: unknown) => ({ file, content: Buffer.from("test") }),
    },
    aigcAssets: { saveInput, removeInput: vi.fn() },
  } as never);
  const node = newWorkflowNode("aigc", "aigc");
  node.config = {
    interfaceId: item.id,
    referenceGroups: {
      refs: {
        mode: "array",
        binding: { kind: "reference", nodeId: "input", field: "images" },
      },
    },
  };
  const draft = emptyWorkflow();
  draft.nodes[0].outputs.push({
    name: "images",
    type: "image",
    multiple: true,
  });
  draft.nodes.push(node);
  await expect(executor.validate(draft as never)).resolves.toBeUndefined();
  draft.nodes[0].outputs[1].type = "audio";
  await expect(executor.validate(draft as never)).rejects.toThrow(
    "image 类型数组",
  );
  const image = { assetId: "one", name: "one.png", mediaType: "image/png" };
  const ctx = {
    node,
    run: { id: "run" },
    signal: new AbortController().signal,
    progress: vi.fn(),
    referenceGroups: { refs: [image] },
  };
  await executor.execute(ctx as never, {});
  expect(createRun).toHaveBeenLastCalledWith({
    interfaceId: item.id,
    inputs: {
      right: { assetId: "one.png", name: "one.png", mediaType: "image/png" },
    },
  });
  ctx.referenceGroups.refs = [];
  await executor.execute(ctx as never, {});
  expect(createRun).toHaveBeenLastCalledWith({
    interfaceId: item.id,
    inputs: {},
  });
  expect(saveInput).toHaveBeenCalledTimes(1);
  ctx.referenceGroups.refs = [image, image, image];
  await expect(executor.execute(ctx as never, {})).rejects.toThrow("最多 2 项");
  expect(createRun).toHaveBeenCalledTimes(2);
});
