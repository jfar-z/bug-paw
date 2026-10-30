// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyWorkflow,
  newWorkflowNode,
  type WorkflowDraft,
} from "../../shared/workflow-contracts";
import { WorkflowService, type WorkflowExecutor } from "./workflow-service";
import { WorkflowRepository } from "./workflow-repository";
import {
  validateWorkflow,
  validateValues,
  checkCustomParameters,
} from "./workflow-validation";
import { runWorkflowScript } from "./workflow-script";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(
  executor: WorkflowExecutor = { execute: async () => ({ text: "完成" }) },
) {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-workflow-test-"));
  const repository = new WorkflowRepository(root),
    service = new WorkflowService(repository, executor);
  await service.initialize();
  cleanup.push(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { service, repository };
}
const ref = (nodeId: string, field = "result") => ({
  kind: "reference" as const,
  nodeId,
  field,
});
/** 完整分支使用真正的脚本和持久化，只有远端能力被替换。 */
function branched(): WorkflowDraft {
  const d = emptyWorkflow(),
    condition = newWorkflowNode("condition", "condition"),
    yes = newWorkflowNode("javascript", "yes"),
    no = newWorkflowNode("javascript", "no"),
    select = newWorkflowNode("select", "select");
  condition.config.conditions = [
    {
      left: ref("input", "prompt"),
      operator: "eq",
      right: { kind: "literal", value: "yes" },
    },
  ];
  yes.config.script = 'return {result:"YES"}';
  no.config.script = 'throw new Error("未激活分支不应运行")';
  select.config.candidates = [ref("yes"), ref("no")];
  d.nodes = [d.nodes[0], condition, yes, no, select, d.nodes[1]];
  d.nodes.at(-1)!.inputs.result = ref("select");
  d.edges = [
    { id: "a", source: "input", target: "condition" },
    { id: "b", source: "condition", target: "yes", branch: "true" },
    { id: "c", source: "condition", target: "no", branch: "false" },
    { id: "d", source: "yes", target: "select" },
    { id: "e", source: "no", target: "select" },
    { id: "f", source: "select", target: "output" },
  ];
  return d;
}
describe("工作流调度与持久化", () => {
  it("默认输入输出运行，幂等重试、快照和版本冲突", async () => {
    const { service, repository } = await fixture();
    const d = await service.save(emptyWorkflow());
    const [a, b] = await Promise.all([
      service.start(d.id, { prompt: "hello" }, "same"),
      service.start(d.id, { prompt: "hello" }, "same"),
    ]);
    expect(a.id).toBe(b.id);
    const done = await service.wait(a.id);
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ result: "hello" });
    await expect(
      service.start(d.id, { prompt: "changed" }, "same"),
    ).rejects.toThrow("requestKey");
    await service.save({ ...d, name: "新版本" }, d.id, d.revision);
    await expect(service.save(d, d.id, d.revision)).rejects.toThrow("其他页面");
    expect(service.getRun(a.id).definition.name).toBe(d.name);
    expect((await repository.runs())[0].outputs).toEqual({ result: "hello" });
  });
  it("互斥分支跳过并通过选择节点汇合", async () => {
    const { service } = await fixture();
    const d = await service.save(branched());
    const run = await service.start(d.id, { prompt: "yes" }, "branch");
    const done = await service.wait(run.id);
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ result: "YES" });
    expect(done.nodes.find((n) => n.nodeId === "no")?.status).toBe("skipped");
    expect(done.nodes.every((n) => n.events.length > 0)).toBe(true);
  });
  it("单个节点失败立即中止并行节点且终态仍为失败", async () => {
    const execute = vi.fn(async ({ node, signal }) => {
      if (node.id === "bad") throw new Error("受控上游失败");
      await new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      });
      return { text: "不应完成" };
    });
    const { service } = await fixture({ execute });
    const d = emptyWorkflow(),
      bad = newWorkflowNode("llm", "bad"),
      slow = newWorkflowNode("llm", "slow");
    for (const n of [bad, slow]) {
      n.config.provider = "test";
      n.config.modelId = "model";
      n.inputs.prompt = ref("input", "prompt");
    }
    d.nodes.splice(1, 0, bad, slow);
    d.nodes.at(-1)!.inputs.result = ref("bad", "text");
    d.edges = [
      { id: "a", source: "input", target: "bad" },
      { id: "b", source: "input", target: "slow" },
      { id: "c", source: "bad", target: "output" },
      { id: "d", source: "slow", target: "output" },
    ];
    const saved = await service.save(d);
    const started = await service.start(
      saved.id,
      { prompt: "test" },
      "parallel",
    );
    const done = await service.wait(started.id);
    expect(done.status).toBe("failed");
    expect(done.error?.message).toContain("受控上游失败");
    expect(done.nodes.find((n) => n.nodeId === "slow")?.status).toBe(
      "cancelled",
    );
  });
  it("取消活动脚本、拒绝跨 Agent 任务访问，重启不重试付费节点", async () => {
    const { service, repository } = await fixture();
    const d = emptyWorkflow(),
      script = newWorkflowNode("javascript", "script");
    script.config.script = "while(true){}";
    script.config.timeoutMs = 5000;
    d.published = true;
    d.nodes.splice(1, 0, script);
    d.nodes.at(-1)!.inputs.result = ref("script");
    d.edges = [
      { id: "a", source: "input", target: "script" },
      { id: "b", source: "script", target: "output" },
    ];
    const saved = await service.save(d),
      origin = { agentId: "a", sessionId: "s" };
    const run = await service.start(
      saved.id,
      { prompt: "hello" },
      "cancel",
      origin,
    );
    expect(() =>
      service.getRun(run.id, { agentId: "b", sessionId: "s" }),
    ).toThrow("无权");
    expect((await service.cancel(run.id, origin)).status).toBe("cancelled");
    const interrupted = {
      ...service.getRun(run.id),
      status: "running" as const,
    };
    await repository.saveRun(interrupted);
    const recovered = new WorkflowService(repository, { execute: vi.fn() });
    await recovered.initialize();
    expect(recovered.getRun(run.id).error?.code).toBe("WORKFLOW_INTERRUPTED");
  });
});
describe("类型与 DAG 验证", () => {
  it("拒绝环路、非上游引用、悬空和输出类型不兼容", () => {
    const d = branched();
    d.edges.push({ id: "cycle", source: "select", target: "condition" });
    expect(() => validateWorkflow(d, true)).toThrow("环路");
    const e = emptyWorkflow();
    e.nodes[1].inputs.result = ref("absent");
    expect(() => validateWorkflow(e, true)).toThrow("非上游");
    const f = emptyWorkflow();
    f.nodes[1].outputs[0].type = "integer";
    expect(() => validateWorkflow(f, true)).toThrow("类型不兼容");
    const g = emptyWorkflow();
    g.nodes.push(newWorkflowNode("javascript", "unused"));
    expect(() => validateWorkflow(g, true)).toThrow("未连接");
  });
  it("保留 0/false，拒绝数值、媒体类型和自定义身份参数错误", () => {
    expect(
      validateValues(
        [
          { name: "count", type: "integer", required: true },
          { name: "enabled", type: "boolean", required: true },
        ],
        { count: 0, enabled: false },
      ),
    ).toEqual({ count: 0, enabled: false });
    expect(() =>
      validateValues([{ name: "n", type: "integer" }], { n: 1.1 }),
    ).toThrow("integer");
    expect(() =>
      validateValues([{ name: "image", type: "image" }], {
        image: { assetId: "x", mediaType: "audio/wav" },
      }),
    ).toThrow("image");
    for (const key of [
      "model",
      "tools",
      "api-key",
      "base_url",
      "contents",
      "config",
    ])
      expect(() => checkCustomParameters({ [key]: "forbidden" })).toThrow(
        "禁止覆盖",
      );
  });
});
describe("JavaScript 沙箱", () => {
  it("转换 JSON 并保留日志，不提供宿主 API", async () => {
    const r = await runWorkflowScript(
      'console.log("step", inputs.n); return {n:inputs.n*2,globals:[typeof process,typeof require,typeof fetch]};',
      { n: 3 },
      1000,
      new AbortController().signal,
    );
    expect(r.output).toEqual({
      n: 6,
      globals: ["undefined", "undefined", "undefined"],
    });
    expect(r.logs).toEqual(["step 3"]);
  });
  it("中断无限循环，拒绝异步、语法错误及内存耗尽", async () => {
    const signal = new AbortController().signal;
    await expect(
      runWorkflowScript("while(true){}", {}, 100, signal),
    ).rejects.toThrow("超时");
    await expect(
      runWorkflowScript("return Promise.resolve({});", {}, 1000, signal),
    ).rejects.toThrow("Promise");
    await expect(
      runWorkflowScript("return {;", {}, 1000, signal),
    ).rejects.toThrow("错误");
    await expect(
      runWorkflowScript(
        'const items=[];while(true)items.push("x".repeat(100000));',
        {},
        1000,
        signal,
      ),
    ).rejects.toThrow();
  }, 15000);
});

/** 类型来源不能成为执行边，枚举仍作为普通字符串在运行中传递。 */
describe("工作流枚举和参考组调度", () => {
  it("输入枚举兼容普通字符串输出，校验默认值和数组元素", async () => {
    const { service } = await fixture();
    const draft = emptyWorkflow();
    draft.nodes[0].outputs[0].enumValues = ["0", "false", "high"];
    draft.nodes[0].outputs[0].defaultValue = "false";
    const saved = await service.save(draft);
    const started = await service.start(saved.id, {}, "enum-default");
    expect((await service.wait(started.id)).outputs).toEqual({
      result: "false",
    });
    await expect(
      service.start(saved.id, { prompt: false }, "bad"),
    ).rejects.toThrow("枚举");
    expect(() =>
      validateValues(
        [
          {
            name: "choices",
            type: "string",
            multiple: true,
            enumValues: ["a"],
          },
        ],
        { choices: ["a", "b"] },
      ),
    ).toThrow("枚举");
  });
  it("下游枚举类型引用不产生环，删除来源或断开连线明确拒绝", () => {
    const draft = emptyWorkflow();
    const aigc = newWorkflowNode("aigc", "aigc");
    aigc.config.interfaceId = "image";
    draft.nodes.splice(1, 0, aigc);
    draft.edges = [
      { id: "a", source: "input", target: "aigc" },
      { id: "b", source: "aigc", target: "output" },
    ];
    draft.nodes[0].outputs[0].enumValues = ["1", "2"];
    draft.nodes[0].outputs[0].enumSource = {
      nodeId: "aigc",
      field: "steps",
      interfaceId: "image",
    };
    expect(() => validateWorkflow(draft, true)).not.toThrow();
    aigc.config.interfaceId = "changed";
    expect(() => validateWorkflow(draft)).toThrow("来源节点或接口已变更");
    aigc.config.interfaceId = "image";
    draft.edges = [];
    expect(() => validateWorkflow(draft)).toThrow("未连接当前节点");
  });
  it.each(["image", "audio", "video"] as const)(
    "%s 可选参考数组缺省、null 和空数组调度及持久化一致，必填参数仍校验",
    async (type) => {
      const execute = vi.fn(async (_context: unknown, _inputs: unknown) => ({
        files: [],
      }));
      const { service, repository } = await fixture({ execute });
      const draft = emptyWorkflow();
      const field = { name: "media", type, multiple: true, required: false };
      draft.nodes[0].outputs.push(field);
      const aigc = newWorkflowNode("aigc", "aigc");
      aigc.config = {
        interfaceId: "media-interface",
        referenceGroups: {
          refs: { mode: "array", binding: ref("input", "media") },
        },
      };
      draft.nodes.splice(1, 0, aigc);
      draft.edges = [
        { id: "a", source: "input", target: "aigc" },
        { id: "b", source: "aigc", target: "output" },
      ];
      const saved = await service.save(draft);
      for (const [index, inputs] of [
        {},
        { media: null },
        { media: [] },
      ].entries()) {
        const run = await service.start(
          saved.id,
          { prompt: "test", ...inputs },
          `empty-${index}`,
        );
        const done = await service.wait(run.id);
        expect(done.status).toBe("succeeded");
        expect(execute.mock.lastCall?.[0]).toMatchObject({
          referenceGroups: { refs: [] },
        });
        const stored = (await repository.runs()).find(
          (item) => item.id === run.id,
        )!;
        expect(
          stored.nodes.find((node) => node.nodeId === "aigc")?.referenceGroups,
        ).toEqual({ refs: [] });
      }
      field.required = true;
      const required = await service.save(draft);
      for (const [index, inputs] of [{}, { media: null }].entries()) {
        await expect(
          service.start(
            required.id,
            { prompt: "test", ...inputs },
            `required-${index}`,
          ),
        ).rejects.toThrow("必填参数 media 未提供");
      }
      expect(execute).toHaveBeenCalledTimes(3);
    },
  );
  it("调度解析参考组上游数组并保存观测数据，非上游引用不能保存", async () => {
    const execute = vi.fn(async (_context: unknown, _inputs: unknown) => ({
      files: [],
    }));
    const { service } = await fixture({ execute });
    const draft = emptyWorkflow();
    draft.nodes[0].outputs.push({
      name: "images",
      type: "image",
      multiple: true,
    });
    const aigc = newWorkflowNode("aigc", "aigc");
    aigc.config = {
      interfaceId: "image",
      referenceGroups: {
        refs: { mode: "array", binding: ref("input", "images") },
      },
    };
    draft.nodes.splice(1, 0, aigc);
    draft.edges = [
      { id: "a", source: "input", target: "aigc" },
      { id: "b", source: "aigc", target: "output" },
    ];
    const image = { assetId: "one", mediaType: "image/png" };
    const saved = await service.save(draft);
    const run = await service.start(
      saved.id,
      { prompt: "test", images: [image] },
      "groups",
    );
    const done = await service.wait(run.id);
    expect(done.status).toBe("succeeded");
    expect(execute.mock.calls[0][0]).toMatchObject({
      referenceGroups: { refs: [image] },
    });
    expect(
      done.nodes.find((n) => n.nodeId === "aigc")?.referenceGroups,
    ).toEqual({ refs: [image] });
    aigc.config.referenceGroups!.refs.binding = ref("output", "result");
    expect(() => validateWorkflow(draft)).toThrow("非上游");
  });
});
