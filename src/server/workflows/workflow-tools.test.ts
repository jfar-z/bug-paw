import { createTestDatabase } from "../database/test-database";
// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowTools, WorkflowToolService } from "./workflow-tools";
import { WorkflowService } from "./workflow-service";
import { WorkflowRepository } from "./workflow-repository";
import { WorkflowFiles } from "./workflow-files";
import { createWorkspaceFileManager } from "../workspace-files";
import { createWorkspaceFileService } from "../attachments";
import {
  emptyWorkflow,
  newWorkflowNode,
} from "../../shared/workflow-contracts";
import {
  CAPABILITY_TOOL_CATALOG,
  DEFAULT_AGENT_TOOL_NAMES,
} from "../../shared/tool-catalog";
const context = { agentId: "agent-a", sessionId: "session-a" };
const names = [
  "workflow_list",
  "workflow_get_parameters",
  "workflow_get_definition",
  "workflow_run",
  "workflow_run_and_wait",
  "workflow_get_task",
  "workflow_cancel_task",
];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-workflow-tools-"));
  await mkdir(join(root, "agents", context.agentId), { recursive: true });
  const agents = {
    resolveWorkspace: async (id: string) => join(root, "agents", id),
  } as never;
  const files = new WorkflowFiles(
    join(root, "files"),
    createWorkspaceFileManager(agents),
    createWorkspaceFileService({} as never, agents),
  );
  const workflows = new WorkflowService(
    new WorkflowRepository(join(root, "workflows"), createTestDatabase()),
    { execute: async () => ({}) },
  );
  await workflows.initialize();
  let allowed = [...names];
  const service = new WorkflowToolService(
    workflows,
    files,
    async () => allowed,
  );
  const tools = createWorkflowTools(context, service);
  const definition = await workflows.save({
    ...emptyWorkflow(),
    published: true,
  });
  cleanup.push(async () => {
    await workflows.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    files,
    workflows,
    service,
    tools,
    definition,
    allow: (next: string[]) => {
      allowed = next;
    },
  };
}
describe("工作流 Agent 工具边界", () => {
  it("七个工具使用根对象必填协议，默认权限不自动扩张", async () => {
    const f = await fixture();
    expect(f.tools.map((t) => t.name)).toEqual(names);
    for (const tool of f.tools) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.required?.length).toBeGreaterThan(0);
      for (const key of ["anyOf", "oneOf", "allOf"])
        expect(tool.parameters).not.toHaveProperty(key);
      expect(DEFAULT_AGENT_TOOL_NAMES).not.toContain(tool.name);
    }
  });
  it("独立参数工具仅返回调用契约，完整保留默认值、枚举和顺序，长脚本不进入结果", async () => {
    const f = await fixture();
    const script = newWorkflowNode("javascript", "internal_script");
    script.config.script = `/* INTERNAL_SCRIPT ${"x".repeat(60_000)} */ return { result: "ok" };`;
    const aigc = newWorkflowNode("aigc", "internal_aigc");
    aigc.config.interfaceId = "internal-interface";
    const draft = emptyWorkflow();
    draft.published = true;
    draft.name = "参数查询测试";
    draft.description = "只需了解输入输出";
    const fields = [
      {
        name: "quality",
        type: "string" as const,
        description: "质量",
        required: true,
        defaultValue: "high",
        enumValues: ["low", "high"],
      },
      { name: "count", type: "integer" as const, defaultValue: 0 },
      { name: "enabled", type: "boolean" as const, defaultValue: false },
      {
        name: "refs",
        type: "image" as const,
        multiple: true,
        required: false,
        defaultValue: [],
      },
      { name: "note", type: "string" as const, defaultValue: "" },
    ];
    draft.nodes[0].outputs.push(...structuredClone(fields));
    draft.nodes[0].outputs[1].enumSource = {
      nodeId: aigc.id,
      field: "quality",
      interfaceId: aigc.config.interfaceId,
    };
    draft.nodes[1].outputs.push({
      name: "pictures",
      type: "image",
      multiple: true,
    });
    draft.nodes[1].inputs.pictures = {
      kind: "reference",
      nodeId: "input",
      field: "refs",
    };
    draft.nodes.splice(1, 0, script, aigc);
    draft.edges = [
      { id: "a", source: "input", target: script.id },
      { id: "b", source: script.id, target: aigc.id },
      { id: "c", source: aigc.id, target: "output" },
    ];
    const saved = await f.workflows.save(draft);
    f.allow(["workflow_get_parameters"]);
    const tool = f.tools.find((t) => t.name === "workflow_get_parameters")!;
    const response = await tool.execute(
      "call",
      { workflowId: saved.id } as never,
      undefined,
      undefined,
      {} as never,
    );
    const content = response.content[0];
    expect(content.type).toBe("text");
    if (content.type !== "text") throw new Error("参数查询应返回文本 JSON");
    const text = content.text;
    expect(JSON.parse(text)).toEqual({
      id: saved.id,
      name: saved.name,
      description: saved.description,
      revision: saved.revision,
      inputs: [saved.nodes[0].outputs[0], ...fields],
      outputs: [
        { name: "result", type: "string", required: true },
        { name: "pictures", type: "image", multiple: true },
      ],
    });
    expect(Buffer.byteLength(text)).toBeLessThan(2000);
    for (const internal of [
      "INTERNAL_SCRIPT",
      "internal_script",
      "internal_aigc",
      "internal-interface",
      "enumSource",
      "nodes",
      "edges",
      "config",
    ])
      expect(text).not.toContain(internal);
    await expect(f.service.definition(context, saved.id)).rejects.toThrow(
      "权限",
    );
    expect(
      CAPABILITY_TOOL_CATALOG.find((item) => item.name === tool.name),
    ).toMatchObject({ highRisk: false });
  });
  it("参数查询要求真实 ID，Schema 和服务层都拒绝非法参数", async () => {
    const f = await fixture();
    const tool = f.tools.find((t) => t.name === "workflow_get_parameters")!;
    expect(Check(tool.parameters, { workflowId: f.definition.id })).toBe(true);
    for (const invalid of [
      {},
      { workflowId: null },
      { workflowId: "" },
      { workflowId: "x".repeat(121) },
      { workflowId: f.definition.id, extra: true },
    ])
      expect(Check(tool.parameters, invalid)).toBe(false);
    for (const workflowId of [undefined, null, "", "   ", "x".repeat(121)])
      await expect(
        tool.execute(
          "call",
          { workflowId } as never,
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow("VALIDATION_FAILED");
  });
  it("参数查询每次检查独立权限、发布状态和资源存在性", async () => {
    const f = await fixture();
    const tool = f.tools.find((t) => t.name === "workflow_get_parameters")!;
    const query = (workflowId: string) =>
      tool.execute(
        "call",
        { workflowId } as never,
        undefined,
        undefined,
        {} as never,
      );
    f.allow(["workflow_get_definition", "workflow_list"]);
    await expect(query(f.definition.id)).rejects.toThrow("FORBIDDEN");
    f.allow(["workflow_get_parameters"]);
    await expect(query(f.definition.id)).resolves.toHaveProperty("content");
    await expect(query("missing")).rejects.toThrow("NOT_FOUND");
    await f.workflows.save(
      { ...f.definition, published: false },
      f.definition.id,
      f.definition.revision,
    );
    await expect(query(f.definition.id)).rejects.toThrow("FORBIDDEN");
    f.allow([]);
    await expect(query(f.definition.id)).rejects.toThrow(
      "workflow_get_parameters 权限",
    );
  });
  it("名称与多行说明修改后在清单、详情及完整定义保持一致，旧说明可读取", async () => {
    const f = await fixture();
    const updated = await f.workflows.save(
      {
        ...f.definition,
        name: "媒体整理",
        description: "生成媒体\n按输入整理输出",
      },
      f.definition.id,
      f.definition.revision,
    );
    const summary = {
      id: updated.id,
      name: updated.name,
      description: updated.description,
    };
    expect(
      await f.service.list(context, {
        action: "list",
        workflowId: null,
        offset: 0,
      }),
    ).toMatchObject({ workflows: [summary] });
    expect(
      await f.service.list(context, {
        action: "get",
        workflowId: updated.id,
        offset: null,
      }),
    ).toMatchObject(summary);
    expect(await f.service.definition(context, updated.id)).toMatchObject(
      summary,
    );
    await expect(
      f.workflows.save(
        { ...updated, name: "过期修改" },
        updated.id,
        f.definition.revision,
      ),
    ).rejects.toThrow("其他页面");
    const legacy = { ...updated, description: undefined };
    await writeFile(
      join(f.root, "workflows", "definitions", `${updated.id}.json`),
      JSON.stringify(legacy),
      "utf8",
    );
    expect(await f.service.definition(context, updated.id)).toMatchObject({
      description: "",
    });
  });
  it("清单、参数和定义读取成功，拒绝条件参数错误、未发布及不存在资源", async () => {
    const f = await fixture();
    expect(
      await f.service.list(context, {
        action: "list",
        workflowId: null,
        offset: 0,
      }),
    ).toMatchObject({ total: 1 });
    expect(
      await f.service.list(context, {
        action: "get",
        workflowId: f.definition.id,
        offset: null,
      }),
    ).toMatchObject({ inputs: [{ name: "prompt", type: "string" }] });
    expect(
      (await f.service.definition(context, f.definition.id)).edges,
    ).toHaveLength(1);
    await expect(
      f.service.list(context, {
        action: "get",
        workflowId: null,
        offset: null,
      }),
    ).rejects.toThrow("get");
    await expect(
      f.service.list(context, {
        action: "list",
        workflowId: f.definition.id,
        offset: 0,
      }),
    ).rejects.toThrow("list");
    await expect(f.service.definition(context, "missing")).rejects.toThrow(
      "不存在",
    );
    await f.workflows.save(
      { ...f.definition, published: false },
      f.definition.id,
      f.definition.revision,
    );
    await expect(
      f.service.definition(context, f.definition.id),
    ).rejects.toThrow("撤销发布");
  });
  it("调用、查询、等待、取消都重新检查独立授权和任务归属", async () => {
    const f = await fixture(),
      input = {
        workflowId: f.definition.id,
        requestKey: "run",
        parameters: [{ name: "prompt", value: "hello" }],
      };
    f.allow(["workflow_run_and_wait"]);
    const run = await f.service.start(context, "workflow_run_and_wait", input);
    expect(await f.service.wait(context, run.id)).toMatchObject({
      status: "succeeded",
      outputs: { result: "hello" },
    });
    await expect(
      f.service.start(context, "workflow_run", {
        ...input,
        requestKey: "forbidden",
      }),
    ).rejects.toThrow("权限");
    await expect(f.service.get(context, run.id)).rejects.toThrow("权限");
    await expect(f.service.cancel(context, run.id)).rejects.toThrow("权限");
    f.allow(names);
    expect(await f.service.cancel(context, run.id)).toMatchObject({
      status: "succeeded",
    });
    for (const method of [
      () => f.service.get({ ...context, agentId: "agent-b" }, run.id),
      () => f.service.cancel({ ...context, agentId: "agent-b" }, run.id),
      () => f.service.get(context, "missing"),
      () => f.service.cancel(context, "missing"),
    ])
      await expect(method()).rejects.toThrow("不存在");
    await expect(
      f.service.start(context, "workflow_run", {
        ...input,
        parameters: [{ name: "invalid", value: 0 }],
      }),
    ).rejects.toThrow("参数名称");
    await expect(
      f.service.start(context, "workflow_run", {
        ...input,
        requestKey: "missing-parameter",
        parameters: [],
      }),
    ).rejects.toThrow("必填");
  });
  it("工具抛出可观测错误，不将异常包装成成功文本", async () => {
    const f = await fixture();
    f.allow([]);
    for (const name of names) {
      const tool = f.tools.find((t) => t.name === name)!;
      await expect(
        tool.execute(
          "call",
          {
            workflowId: f.definition.id,
            taskId: "missing",
            action: "list",
            offset: 0,
            requestKey: "key",
            parameters: [],
          } as never,
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow("FORBIDDEN");
    }
  });
  it("媒体路径相同的幂等重试不会重复执行，输出只交付所属 Agent", async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, "agents", context.agentId, "input.png"),
      "fake image",
    );
    const d = emptyWorkflow();
    d.published = true;
    d.nodes[0].outputs = [{ name: "picture", type: "image", required: true }];
    d.nodes[1].outputs = [{ name: "result", type: "image", required: true }];
    d.nodes[1].inputs.result = {
      kind: "reference",
      nodeId: "input",
      field: "picture",
    };
    const saved = await f.workflows.save(d);
    const args = {
      workflowId: saved.id,
      requestKey: "media",
      parameters: [{ name: "picture", value: "input.png" }],
    };
    const a = await f.service.start(context, "workflow_run", args),
      b = await f.service.start(context, "workflow_run", args);
    expect(a.id).toBe(b.id);
    await f.workflows.wait(a.id);
    expect(await f.service.get(context, a.id)).toMatchObject({
      outputs: { result: { path: expect.stringContaining("attachments/") } },
    });
    const foreign = await f.files.upload(
      Readable.from("other"),
      "other.png",
      "image/png",
      "agent-b",
    );
    await expect(f.files.resolve(foreign, context.agentId)).rejects.toThrow(
      "不属于",
    );
    await expect(f.files.resolve({ assetId: "../../outside" })).rejects.toThrow(
      "不合法",
    );
    await expect(
      f.service.start(context, "workflow_run", {
        ...args,
        requestKey: "outside",
        parameters: [{ name: "picture", value: "../agent-b/private.png" }],
      }),
    ).rejects.toThrow();
  });
});
