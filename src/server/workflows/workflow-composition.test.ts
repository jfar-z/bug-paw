// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyWorkflow,
  newWorkflowNode,
  workflowLoopOutputs,
  type WorkflowDefinition,
  type WorkflowDraft,
  type WorkflowNode,
} from "../../shared/workflow-contracts";
import { createTestDatabase } from "../database/test-database";
import { WorkflowRepository } from "./workflow-repository";
import { WorkflowService, type WorkflowExecutor } from "./workflow-service";
import { validateWorkflow } from "./workflow-validation";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const literal = (value: unknown) => ({ kind: "literal" as const, value });
const ref = (nodeId: string, field = "result") => ({
  kind: "reference" as const,
  nodeId,
  field,
});
async function fixture(
  executor: WorkflowExecutor = { execute: async () => ({ text: "完成" }) },
) {
  const directory = await mkdtemp(join(tmpdir(), "bugpaw-composition-"));
  const database = createTestDatabase();
  const repository = new WorkflowRepository(directory, database);
  const service = new WorkflowService(repository, executor);
  await service.initialize();
  cleanup.push(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, repository };
}
/** 外部流程的输出完全来自被测容器，不借助测试专用执行分支。 */
function graphWith(node: WorkflowNode): WorkflowDraft {
  const draft = emptyWorkflow();
  draft.nodes[0].outputs = [];
  draft.nodes[1].outputs = structuredClone(node.outputs);
  draft.nodes[1].inputs = Object.fromEntries(
    node.outputs.map((field) => [field.name, ref(node.id, field.name)]),
  );
  draft.nodes = [draft.nodes[0], node, draft.nodes[1]];
  draft.edges = [
    { id: "in", source: "input", target: node.id },
    { id: "out", source: node.id, target: "output" },
  ];
  return draft;
}
function call(definition: WorkflowDefinition, id = "call"): WorkflowNode {
  const node = newWorkflowNode("workflow", id);
  node.config.workflowId = definition.id;
  node.outputs = structuredClone(
    definition.nodes.find((n) => n.kind === "output")!.outputs,
  );
  node.inputs = { prompt: literal("hello") };
  return node;
}
async function run(service: WorkflowService, draft: WorkflowDraft) {
  const definition = await service.save(draft);
  const started = await service.start(definition.id, {}, "test");
  return service.wait(started.id);
}
/** 使用真实 JS 沙箱计算每轮状态，覆盖状态提交和下一轮条件判断。 */
function whileLoop() {
  const node = newWorkflowNode("loop", "loop");
  const loop = node.config.loop!;
  const step = newWorkflowNode("javascript", "step");
  step.inputs = { value: ref("input", "value") };
  step.config.script = "return {result: inputs.value + 1}";
  step.outputs = [{ name: "result", type: "integer", required: true }];
  loop.body = graphWith(step);
  loop.body.nodes[0].outputs = [
    { name: "index", type: "integer", required: true },
    { name: "value", type: "integer", required: true },
  ];
  loop.mode = "while";
  loop.state = { value: { initial: literal(0), output: "result" } };
  loop.condition = {
    left: ref("input", "value"),
    operator: "lt",
    right: literal(3),
  };
  node.outputs = workflowLoopOutputs(loop);
  return node;
}

describe("循环与嵌套工作流", () => {
  it("次数引用上游整数并在保存时拒绝错误类型", async () => {
    const { service } = await fixture();
    const node = newWorkflowNode("loop", "loop");
    node.config.loop!.count = ref("input", "times");
    const draft = graphWith(node);
    draft.nodes[0].outputs = [
      { name: "times", type: "integer", required: true },
    ];
    const definition = await service.save(draft);
    const started = await service.start(
      definition.id,
      { times: 2 },
      "reference-count",
    );
    expect((await service.wait(started.id)).outputs).toEqual({
      result: [0, 1],
    });
    draft.nodes[0].outputs[0].type = "string";
    await expect(service.save(draft)).rejects.toThrow("上游类型不兼容");
  });
  it("零次循环必填最后一轮没有默认值时明确失败", async () => {
    const { service } = await fixture();
    const node = newWorkflowNode("loop", "loop");
    node.config.loop!.count = literal(0);
    node.config.loop!.outputs.result.mode = "last";
    node.outputs = workflowLoopOutputs(node.config.loop!);
    const done = await run(service, graphWith(node));
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("VALIDATION_FAILED");
    expect(done.error?.message).toContain("result");
    expect(done.nodes[1].children).toBeUndefined();
  });
  it("次数循环隔离每轮节点状态并按顺序收集 0", async () => {
    const { service, repository } = await fixture();
    const done = await run(service, graphWith(newWorkflowNode("loop", "loop")));
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ result: [0, 1, 2] });
    const children = done.nodes[1].children!;
    expect(children).toHaveLength(3);
    expect(new Set(children.map((child) => child.id)).size).toBe(3);
    expect(children.every((child) => child.status === "succeeded")).toBe(true);
    expect((await repository.runs())[0].nodes[1].children).toHaveLength(3);
  });
  it("数组迭代保留 false 与元素顺序", async () => {
    const { service } = await fixture();
    const node = newWorkflowNode("loop", "loop"),
      loop = node.config.loop!;
    loop.mode = "array";
    loop.items = literal([false, true, false]);
    loop.body.nodes[0].outputs.push({
      name: "item",
      type: "boolean",
      required: true,
    });
    loop.body.nodes[1].outputs = [
      { name: "result", type: "boolean", required: true },
    ];
    loop.body.nodes[1].inputs.result = ref("input", "item");
    node.outputs = workflowLoopOutputs(loop);
    expect((await run(service, graphWith(node))).outputs).toEqual({
      result: [false, true, false],
    });
  });
  it("while 使用初始状态并在成功后更新，条件为假时终止", async () => {
    const { service } = await fixture();
    const done = await run(service, graphWith(whileLoop()));
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ result: [1, 2, 3] });
    expect(done.nodes[1].children?.map((child) => child.inputs.value)).toEqual([
      0, 1, 2,
    ]);
  });
  it("while 超过上限失败，保留已完成轮次且外部下游停止", async () => {
    const { service } = await fixture();
    const node = whileLoop();
    node.config.loop!.maxIterations = 2;
    const done = await run(service, graphWith(node));
    expect(done.status).toBe("failed");
    expect(done.error?.message).toContain("条件仍为真");
    expect(done.nodes[1].children).toHaveLength(2);
    expect(done.nodes[2].status).not.toBe("succeeded");
  });
  it.each(["count", "array"] as const)("%s 空循环产生空集合", async (mode) => {
    const { service } = await fixture();
    const node = newWorkflowNode("loop", "loop");
    node.config.loop!.mode = mode;
    node.config.loop!.count = literal(0);
    if (mode === "array")
      node.config.loop!.body.nodes[0].outputs.push({
        name: "item",
        type: "integer",
      });
    const done = await run(service, graphWith(node));
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ result: [] });
    expect(done.nodes[1].children).toBeUndefined();
  });
  it("最后一轮使用零次默认值，while 状态输出保留初始值", async () => {
    const { service } = await fixture();
    const node = whileLoop(),
      loop = node.config.loop!;
    loop.state.value.initial = literal(5);
    loop.outputs.result.mode = "last";
    node.outputs = workflowLoopOutputs(loop);
    const done = await run(service, graphWith(node));
    expect(done.outputs).toEqual({ result: 5 });
    expect(done.nodes[1].children).toBeUndefined();
  });
  it("非状态的最后一轮零次执行采用显式默认值", async () => {
    const { service } = await fixture();
    const node = newWorkflowNode("loop", "loop");
    node.config.loop!.count = literal(0);
    node.config.loop!.outputs.result.mode = "last";
    node.outputs = workflowLoopOutputs(node.config.loop!);
    node.outputs[0].defaultValue = 7;
    const done = await run(service, graphWith(node));
    expect(done.outputs).toEqual({ result: 7 });
  });
  it("每轮数组合并为一维并保留文件引用", async () => {
    const { service } = await fixture();
    const node = newWorkflowNode("loop", "loop"),
      loop = node.config.loop!;
    const file = {
      assetId: "test-image",
      name: "test.png",
      mediaType: "image/png",
      size: 10,
    };
    loop.body.nodes[1].outputs = [
      { name: "result", type: "image", multiple: true, required: true },
    ];
    loop.body.nodes[1].inputs.result = literal([file]);
    loop.outputs.result.mode = "flatten";
    node.outputs = workflowLoopOutputs(loop);
    expect((await run(service, graphWith(node))).outputs).toEqual({
      result: [file, file, file],
    });
  });
  it("嵌套循环分别维护作用域，内部输出可由外层合并", async () => {
    const { service } = await fixture();
    const inner = newWorkflowNode("loop", "inner"),
      outer = newWorkflowNode("loop", "outer");
    outer.config.loop!.body = graphWith(inner);
    outer.config.loop!.body.nodes[0].outputs = [
      { name: "index", type: "integer", required: true },
    ];
    outer.config.loop!.outputs.result.mode = "flatten";
    outer.outputs = workflowLoopOutputs(outer.config.loop!);
    const done = await run(service, graphWith(outer));
    expect(done.status).toBe("succeeded");
    expect(done.outputs.result).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
  });
  it("子工作流复用真实输入输出，未开放 Agent 的目标仍允许内部调用", async () => {
    const { service } = await fixture();
    const target = await service.save(emptyWorkflow());
    const done = await run(service, graphWith(call(target)));
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ result: "hello" });
    expect(done.dependencies?.[target.id].revision).toBe(1);
    expect(done.nodes[1].children?.[0].definition.id).toBe(target.id);
    await expect(service.remove(target.id, target.revision)).rejects.toThrow(
      "引用",
    );
  });
  it("拒绝直接和间接环路并给出依赖路径", async () => {
    const { service } = await fixture();
    const a = await service.save({ ...emptyWorkflow(), name: "A" });
    await expect(
      service.save({ ...graphWith(call(a)), name: "A" }, a.id, a.revision),
    ).rejects.toThrow("A");
    const b = await service.save({ ...graphWith(call(a)), name: "B" });
    await expect(
      service.save({ ...graphWith(call(b)), name: "A" }, a.id, a.revision),
    ).rejects.toThrow(/A.*→.*B.*→.*A/);
    expect(
      service.catalogWorkflows().find((item) => item.id === b.id)?.dependencies,
    ).toContain(a.id);
  });
  it("循环内工作流枚举通过保存和真实嵌套执行，目录只公开选项元数据", async () => {
    const execute = vi.fn();
    const { service } = await fixture({ execute });
    const draft = emptyWorkflow();
    draft.nodes[0].outputs = [{ name: "ratio", type: "string", required: true, enumValues: ["16:9", "9:16"], defaultValue: "16:9", description: "画幅" }];
    draft.nodes[1].inputs.result = ref("input", "ratio");
    const target = await service.save(draft);
    expect(service.catalogWorkflows().find((item) => item.id === target.id)?.enumFields).toEqual([{ name: "ratio", values: ["16:9", "9:16"] }]);
    const child = call(target);
    child.inputs = { ratio: ref("input", "ratio") };
    const loop = newWorkflowNode("loop", "loop");
    loop.inputs.ratio = literal("9:16");
    loop.config.loop!.body = graphWith(child);
    loop.config.loop!.body.nodes[0].outputs = [
      { name: "index", type: "integer", required: true },
      { name: "ratio", type: "string", required: true, enumValues: ["16:9", "9:16"], enumSource: { nodeId: "call", field: "ratio", workflowId: target.id } },
    ];
    loop.outputs = workflowLoopOutputs(loop.config.loop!);
    const done = await run(service, graphWith(loop));
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ result: ["9:16", "9:16", "9:16"] });
    expect(execute).not.toHaveBeenCalled();
  });
  it("子工作流枚举修改、移除或退回字符串后，保存和启动均拒绝过期选项", async () => {
    const execute = vi.fn(), validate = vi.fn();
    const { service } = await fixture({ execute, validate });
    const targetDraft = emptyWorkflow();
    targetDraft.nodes[0].outputs[0].enumValues = ["16:9", "9:16"];
    let target = await service.save(targetDraft);
    const caller = call(target), parentDraft = graphWith(caller);
    caller.inputs.prompt = ref("input", "prompt");
    parentDraft.nodes[0].outputs = [{ name: "prompt", type: "string", enumValues: ["16:9", "9:16"], enumSource: { nodeId: "call", field: "prompt", workflowId: target.id } }];
    const parent = await service.save(parentDraft);
    for (const options of [["1:1"], undefined]) {
      const next = structuredClone(target);
      next.nodes[0].outputs[0].enumValues = options;
      target = await service.save(next, target.id, target.revision);
      await expect(service.save(parentDraft, parent.id, parent.revision)).rejects.toThrow("工作流枚举入参 prompt 已变更");
      await expect(service.start(parent.id, { prompt: "16:9" }, "stale-enum")).rejects.toThrow("工作流枚举入参 prompt 已变更");
    }
    expect(execute).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(service.listRuns()).toHaveLength(0);
    const next = structuredClone(target);
    next.nodes[0].outputs = [];
    next.nodes[1].inputs.result = literal("fixed");
    await service.save(next, target.id, target.revision);
    await expect(service.start(parent.id, {}, "removed-enum")).rejects.toThrow("工作流枚举入参 prompt 已变更");
  });
  it("工作流枚举来源必须属于同一连通作用域，不能换目标或同时声明接口来源", async () => {
    const { service } = await fixture();
    const targetDraft = emptyWorkflow();
    targetDraft.nodes[0].outputs[0].enumValues = ["16:9", "9:16"];
    const target = await service.save(targetDraft);
    const draft = graphWith(call(target));
    const source = { nodeId: "call", field: "prompt", workflowId: target.id };
    draft.nodes[0].outputs = [{ name: "prompt", type: "string", enumValues: ["16:9", "9:16"], enumSource: source }];
    const changed = structuredClone(draft);
    changed.nodes[1].config.workflowId = "another";
    expect(() => validateWorkflow(changed)).toThrow("调用目标已变更");
    const detached = structuredClone(draft);
    detached.edges = [];
    expect(() => validateWorkflow(detached)).toThrow("枚举来源未连接");
    const invalid = structuredClone(draft);
    invalid.nodes[0].outputs[0].enumSource = { ...source, interfaceId: "fake" } as never;
    expect(() => validateWorkflow(invalid)).toThrow("枚举来源格式无效");
  });
  it("保存时检查循环体里的工作流依赖", async () => {
    const { service } = await fixture();
    const target = await service.save(emptyWorkflow());
    const node = newWorkflowNode("loop", "loop");
    node.config.loop!.body = graphWith(call(target));
    node.config.loop!.body.nodes[0].outputs = [
      { name: "index", type: "integer", required: true },
    ];
    node.outputs = workflowLoopOutputs(node.config.loop!);
    await expect(
      service.save(graphWith(node), target.id, target.revision),
    ).rejects.toThrow("循环依赖");
  });
  it("文件被绕过服务手动修改后，运行前重新拒绝环路", async () => {
    const { service, repository } = await fixture();
    const a = await service.save(emptyWorkflow());
    const b = await service.save(graphWith(call(a)));
    repository.mutateDefinition(a.id, () => ({
      value: { ...a, ...graphWith(call(b)) },
      result: undefined,
    }));
    await expect(service.start(a.id, {}, "cycle")).rejects.toThrow("循环依赖");
    expect(service.listRuns()).toHaveLength(0);
  });
  it("目标参数变化后明确拒绝失效契约", async () => {
    const { service } = await fixture();
    const target = await service.save(emptyWorkflow());
    const parent = await service.save(graphWith(call(target)));
    const next = structuredClone(target);
    next.nodes[1].outputs[0].type = "integer";
    next.nodes[1].inputs.result = literal(8);
    await service.save(next, target.id, target.revision);
    await expect(service.start(parent.id, {}, "changed")).rejects.toThrow(
      "出参已变化",
    );
  });
  it("启动时固定子定义，运行中编辑不影响当前调用", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = vi.fn();
    const { service } = await fixture({
      execute: async () => {
        entered();
        await waiting;
        return { text: "ready" };
      },
    });
    const target = await service.save(emptyWorkflow());
    const caller = call(target),
      wait = newWorkflowNode("llm", "wait");
    wait.config.provider = "test";
    wait.config.modelId = "test";
    wait.inputs.prompt = literal("wait");
    const draft = graphWith(caller);
    draft.nodes.splice(1, 0, wait);
    draft.edges = [
      { id: "a", source: "input", target: "wait" },
      { id: "b", source: "wait", target: "call" },
      { id: "c", source: "call", target: "output" },
    ];
    const definition = await service.save(draft);
    const started = await service.start(definition.id, {}, "snapshot");
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    const next = structuredClone(target);
    next.nodes[1].inputs.result = literal("changed");
    await service.save(next, target.id, target.revision);
    release();
    const done = await service.wait(started.id);
    expect(done.outputs).toEqual({ result: "hello" });
    expect(
      done.nodes.find((n) => n.nodeId === "call")?.children?.[0].definition
        .revision,
    ).toBe(1);
  });
  it("循环体外部引用和错误汇总类型无法绕过作用域校验", () => {
    const node = newWorkflowNode("loop", "loop");
    node.config.loop!.body.nodes[1].inputs.result = ref("external", "text");
    expect(() => validateWorkflow(graphWith(node), true)).toThrow("非上游");
    const bad = newWorkflowNode("loop", "bad");
    bad.config.loop!.outputs.result.mode = "flatten";
    expect(() => validateWorkflow(graphWith(bad), true)).toThrow("汇总方式");
  });
  it("某一轮失败保留错误轮次，后续轮次与外部输出不执行", async () => {
    const { service } = await fixture();
    const node = newWorkflowNode("loop", "loop"),
      step = newWorkflowNode("javascript", "step");
    step.inputs = { index: ref("input", "index") };
    step.config.script =
      'if(inputs.index === 1) throw new Error("第二轮计算失败"); return { result: inputs.index };';
    step.outputs = [{ name: "result", type: "integer", required: true }];
    node.config.loop!.body = graphWith(step);
    node.config.loop!.body.nodes[0].outputs = [
      { name: "index", type: "integer", required: true },
    ];
    const done = await run(service, graphWith(node));
    expect(done.status).toBe("failed");
    expect(done.error?.message).toContain("第 2 轮");
    expect(done.error?.message).toContain("第二轮计算失败");
    expect(done.error?.requestId).toBe(done.id);
    expect(done.nodes[1].children?.map((child) => child.status)).toEqual([
      "succeeded",
      "failed",
    ]);
  });
  it("并行子调用共用最多三个叶节点并发许可且不会容器等待死锁", async () => {
    let active = 0,
      peak = 0;
    let release!: () => void;
    const firstWave = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = await fixture({
      execute: async () => {
        peak = Math.max(peak, ++active);
        if (active === 3) release();
        await firstWave;
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
        return { text: "ok" };
      },
    });
    const leaves = [0, 1, 2].map((i) => {
      const node = newWorkflowNode("llm", `leaf_${i}`);
      node.config.provider = "test";
      node.config.modelId = "test";
      node.inputs.prompt = literal("test");
      return node;
    });
    const targetDraft = graphWith(leaves[0]);
    targetDraft.nodes = [
      targetDraft.nodes[0],
      ...leaves,
      targetDraft.nodes.at(-1)!,
    ];
    targetDraft.edges = leaves.flatMap((node) => [
      { id: `in_${node.id}`, source: "input", target: node.id },
      { id: `out_${node.id}`, source: node.id, target: "output" },
    ]);
    const target = await service.save(targetDraft);
    const calls = [0, 1, 2].map((i) => {
      const node = call(target, `call_${i}`);
      node.inputs = {};
      return node;
    });
    const parent = graphWith(calls[0]);
    parent.nodes = [parent.nodes[0], ...calls, parent.nodes.at(-1)!];
    parent.edges = calls.flatMap((node) => [
      { id: `in_${node.id}`, source: "input", target: node.id },
      { id: `out_${node.id}`, source: node.id, target: "output" },
    ]);
    const done = await run(service, parent);
    expect(done.status).toBe("succeeded");
    expect(peak).toBe(3);
    expect(active).toBe(0);
  });
  it("取消根任务传递到循环内子工作流并保留调用方归属", async () => {
    let entered = false,
      aborted = false;
    const { service } = await fixture({
      execute: async (ctx) => {
        expect(ctx.run.origin).toEqual({
          agentId: "agent",
          sessionId: "session",
        });
        entered = true;
        await new Promise<void>((_, reject) =>
          ctx.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(ctx.signal.reason);
            },
            { once: true },
          ),
        );
        return { text: "unreachable" };
      },
    });
    const leaf = newWorkflowNode("llm", "leaf");
    leaf.config.provider = "test";
    leaf.config.modelId = "test";
    leaf.inputs.prompt = literal("test");
    const target = await service.save(graphWith(leaf));
    const node = newWorkflowNode("loop", "loop");
    const invocation = call(target);
    invocation.inputs = {};
    node.config.loop!.body = graphWith(invocation);
    node.config.loop!.outputs = { text: { field: "text", mode: "collect" } };
    node.config.loop!.body.nodes[0].outputs = [
      { name: "index", type: "integer", required: true },
    ];
    node.outputs = workflowLoopOutputs(node.config.loop!);
    const definition = await service.save({
      ...graphWith(node),
      published: true,
    });
    const started = await service.start(definition.id, {}, "cancel", {
      agentId: "agent",
      sessionId: "session",
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    await service.cancel(started.id);
    const done = await service.wait(started.id);
    expect(aborted).toBe(true);
    expect(done.status).toBe("cancelled");
    expect(done.nodes[1].children).toHaveLength(1);
    expect(done.nodes[1].children?.[0].nodes[1].children?.[0].status).toBe(
      "cancelled",
    );
  });
  it("重启递归终止所有活动子轨迹，不重试节点", async () => {
    const { service, repository } = await fixture();
    const done = await run(service, graphWith(newWorkflowNode("loop", "loop")));
    done.status = "running";
    done.nodes[1].status = "running";
    const child = done.nodes[1].children![0];
    child.status = "running";
    child.nodes[0].status = "running";
    child.nodes[1].status = "queued";
    await repository.saveRun(done);
    const execute = vi.fn();
    const restarted = new WorkflowService(repository, { execute });
    await restarted.initialize();
    cleanup.push(() => restarted.close());
    const recovered = restarted.getRun(done.id);
    expect(recovered.status).toBe("failed");
    expect(recovered.nodes[1].children?.[0].status).toBe("failed");
    expect(recovered.nodes[1].children?.[0].nodes.map((n) => n.status)).toEqual(
      ["failed", "skipped"],
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("目录单项失效不会阻止其他工作流选择，原因明确可见", async () => {
    const { service, repository } = await fixture();
    const healthy = await service.save(emptyWorkflow());
    const broken = await service.save({ ...emptyWorkflow(), name: "损坏定义" });
    repository.mutateDefinition(broken.id, () => ({
      value: { ...broken, edges: [] },
      result: undefined,
    }));
    const catalog = service.catalogWorkflows();
    expect(
      catalog.find((item) => item.id === healthy.id)?.unavailable,
    ).toBeUndefined();
    // 草稿断线仍可保存；非法节点集合必须作为目录中明确的不可用项。
    repository.mutateDefinition(broken.id, () => ({
      value: { ...broken, nodes: [] },
      result: undefined,
    }));
    expect(
      service.catalogWorkflows().find((item) => item.id === broken.id)
        ?.unavailable,
    ).toContain("2 到 100");
  });
});
