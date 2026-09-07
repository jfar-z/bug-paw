import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStore } from "../agents/agent-store";
import { createWorkspaceFileService } from "../attachments";
import { createWorkspaceFileManager } from "../workspace-files";
import { CredentialService } from "../configuration/credential-service";
import { DEFAULT_AGENT_TOOL_NAMES } from "../../shared/tool-catalog";
import { AigcAssetService } from "./aigc-asset-service";
import { AigcConnectionService } from "./aigc-connection-service";
import { AigcInterfaceService } from "./aigc-interface-service";
import { AigcWorkflowService } from "./aigc-workflow-service";
import { AigcTaskRepository } from "./aigc-task-repository";
import { AigcTaskService } from "./aigc-task-service";
import { AigcAgentService } from "./aigc-agent-service";
import type { AigcAgentLimits } from "./aigc-agent-limits";
import { createAigcAgentTools } from "./aigc-agent-tools";
import { agentFields, validateAgentParameters } from "./aigc-agent-parameters";
import type { AigcExecutionInput, AigcExecutionResult } from "./aigc-protocol-adapter";
import type { AigcWorkflowDetail } from "../../shared/aigc-contracts";

const context = { agentId: "agent-a", sessionId: "session-a" };
const toolNames = ["aigc_list_interfaces", "aigc_run", "aigc_get_task", "aigc_cancel_task", "aigc_run_and_wait"];
const pending = (input: AigcExecutionInput): Promise<AigcExecutionResult> => new Promise((_resolve, reject) => {
  input.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
});

/** 使用真实任务存储、文件边界和发布配置，仅替换上游生成服务。 */
async function fixture(
  execute: (input: AigcExecutionInput) => Promise<AigcExecutionResult> = async () => ({
    assets: [{ name: "result.png", mediaType: "image/png", content: Buffer.from("result") }],
  }),
  limits?: AigcAgentLimits,
) {
  const root = await mkdtemp(join(tmpdir(), "aigc-agent-"));
  const workspaces = join(root, "workspaces");
  await mkdir(join(workspaces, "agent-a"), { recursive: true });
  await mkdir(join(workspaces, "agent-b"), { recursive: true });
  const agents = { resolveWorkspace: async (id: string) => join(workspaces, id) } as AgentStore;
  const workspace = createWorkspaceFileManager(agents);
  const files = createWorkspaceFileService({} as never, agents);
  const connections = new AigcConnectionService(join(root, "connections.json"));
  await connections.create({ name: "Test", type: "openai", baseUrl: "https://private.invalid/v1", enabled: true }, "channel", (await connections.read()).revision);
  const workflows = new AigcWorkflowService(join(root, "workflows.json"));
  const interfaces = new AigcInterfaceService(join(root, "interfaces.json"), (id) => workflows.exists(id));
  const { item } = await interfaces.create({
    name: "测试接口", description: "生成测试", protocol: "openai", capability: "text-to-image",
    channelId: "channel", enabled: true, toolPublishEnabled: true,
    config: { model: "test", parameters: [{ name: "steps", type: "integer", defaultValue: 8, description: "步数" }] },
  });
  const assets = new AigcAssetService(join(root, "assets"));
  const repository = new AigcTaskRepository(join(root, "tasks.json"));
  const adapter = { execute: vi.fn(execute) };
  const tasks = new AigcTaskService({
    repository, interfaces, workflows, connections, assets, publicFiles: {} as never,
    credentials: new CredentialService(join(root, "auth.json")), adapters: { openai: adapter },
  });
  let allowed = [...toolNames];
  const dependencies = { interfaces, workflows, connections, assets, tasks, workspace, files, allowedTools: async () => allowed };
  const service = limits ? new AigcAgentService(dependencies, limits) : new AigcAgentService(dependencies);
  const tools = createAigcAgentTools(context, service);
  const submit = (requestKey = "one") => ({ interfaceId: item.id, requestKey, parameters: [{ name: "prompt", text: "test" }] });
  const close = async () => {
    await tasks.close();
    await rm(root, { recursive: true, force: true });
  };
  cleanup.push(close);
  return { root, workspaces, service, tools, tasks, repository, interfaces, connections, workflows, assets, adapter, item, submit,
    revoke: () => { allowed = []; },
    setAllowed: (names: string[]) => { allowed = names; },
    unpublish: async () => interfaces.update(item.id, { ...item, toolPublishEnabled: false }, (await interfaces.list()).revision),
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

describe("AIGC Agent 工具", () => {
  it("阻塞工具仅需自身授权，等待真实完成并通过回调报告进度与交付产物", async () => {
    const f = await fixture(async (input) => {
      input.onProgress?.({ phase: "running", progressValue: 1, progressMax: 2, updatedAt: new Date().toISOString() });
      return { assets: [{ name: "result.png", mediaType: "image/png", content: Buffer.from("result") }] };
    });
    f.setAllowed(["aigc_run_and_wait"]);
    const updates = vi.fn();
    const tool = f.tools.find((entry) => entry.name === "aigc_run_and_wait")!;
    const output = await tool.execute("wait-call", f.submit(), undefined, updates, {} as never);
    const block = output.content[0];
    if (block.type !== "text") throw new Error("工具必须返回文本结果");
    const payload = JSON.parse(block.text);
    expect(payload.data).toMatchObject({ status: "succeeded", waitStatus: "completed" });
    expect(payload.data.files).toHaveLength(1);
    expect(updates).toHaveBeenCalled();
    expect(JSON.parse(updates.mock.calls[0][0].content[0].text).data.taskId).toBe(payload.data.taskId);
    expect(f.adapter.execute).toHaveBeenCalledOnce();
    await expect(f.service.run(context, f.submit("denied"))).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
    await expect(f.service.get(context, payload.data.taskId)).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
  }, 15_000);

  it("中止阻塞等待保留后台任务，未取消上游且同键再次等待不重复提交", async () => {
    const f = await fixture(pending);
    const controller = new AbortController();
    const state = await f.service.runAndWait(context, f.submit(), controller.signal, () => controller.abort());
    expect(state.waitStatus).toBe("interrupted");
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledOnce());
    expect(f.adapter.execute.mock.calls[0][0].signal.aborted).toBe(false);
    const again = new AbortController();
    const resumed = await f.service.runAndWait(context, f.submit(), again.signal, () => again.abort());
    expect(resumed.taskId).toBe(state.taskId);
    expect(f.adapter.execute).toHaveBeenCalledOnce();
    expect((await f.tasks.get(state.taskId))?.status).toBe("running");
  });

  it("等待上限到达返回当前任务而不取消或重提", async () => {
    const f = await fixture(pending);
    const now = Date.now();
    const state = await f.service.runAndWait(context, f.submit(), undefined, () => {
      vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60_000 + 1);
    });
    expect(state).toMatchObject({ waitStatus: "timed_out" });
    expect(["queued", "running"]).toContain(state.status);
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledOnce());
    expect(f.adapter.execute.mock.calls[0][0].signal.aborted).toBe(false);
  });

  it("两种工具共享幂等，已失败或取消的任务直接返回终态", async () => {
    const f = await fixture(async () => { throw new Error("upstream failure"); });
    const submitted = await f.service.run(context, f.submit());
    await vi.waitFor(async () => expect((await f.tasks.get(submitted.taskId))?.status).toBe("failed"));
    const state = await f.service.runAndWait(context, f.submit());
    expect(state).toMatchObject({ taskId: submitted.taskId, status: "failed", waitStatus: "completed", files: [] });
    expect(f.adapter.execute).toHaveBeenCalledOnce();
    await f.repository.update(submitted.taskId, { status: "cancelled" });
    expect(await f.service.runAndWait(context, f.submit())).toMatchObject({ status: "cancelled", waitStatus: "completed" });
  });

  it("等待期间撤销授权或发布会阻止继续读取，参数错误不产生任务", async () => {
    const f = await fixture(pending);
    await expect(f.service.runAndWait(context, { ...f.submit(), parameters: [] })).rejects.toBeInstanceOf(TypeError);
    expect(await f.tasks.listRecords()).toHaveLength(0);
    await expect(f.service.runAndWait(context, f.submit(), undefined, () => f.revoke())).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
    f.setAllowed(toolNames);
    await f.unpublish();
    await expect(f.service.runAndWait(context, f.submit())).rejects.toMatchObject({ code: "AIGC_INTERFACE_UNAVAILABLE" });
  });

  it("工具根 Schema 为对象且默认不授权，列表不泄露渠道地址", async () => {
    const f = await fixture();
    expect(f.tools.map((tool) => tool.name)).toEqual(toolNames);
    for (const tool of f.tools) {
      expect(tool.parameters.type).toBe("object");
      for (const key of ["anyOf", "oneOf", "allOf"]) expect(tool.parameters).not.toHaveProperty(key);
      expect(DEFAULT_AGENT_TOOL_NAMES).not.toContain(tool.name);
    }
    const list = await f.service.list(context, {});
    expect(JSON.stringify(list)).not.toContain("private.invalid");
    expect(list.interfaces).toHaveLength(1);
    const detail = await f.service.list(context, { interfaceId: f.item.id });
    expect(detail.interfaces[0]).toHaveProperty("fields", expect.arrayContaining([expect.objectContaining({ name: "steps", defaultValue: 8 })]));
    await f.unpublish();
    expect((await f.service.list(context, {})).interfaces).toHaveLength(0);
    await expect(f.service.list(context, { interfaceId: f.item.id })).rejects.toMatchObject({ code: "AIGC_INTERFACE_UNAVAILABLE" });
  });

  it("并发重试只生成一次，记录身份且跨重启保持幂等凭据", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.service.run(context, f.submit()), f.service.run(context, f.submit())]);
    expect(a.taskId).toBe(b.taskId);
    await vi.waitFor(async () => expect((await f.tasks.get(a.taskId))?.status).toBe("succeeded"));
    expect(f.adapter.execute).toHaveBeenCalledTimes(1);
    const stored = await new AigcTaskRepository(join(f.root, "tasks.json")).get(a.taskId);
    expect(stored?.agentOrigin).toMatchObject({ ...context, requestKey: "one" });
    expect(f.adapter.execute.mock.calls[0][0].inputs.steps).toBe(8);
    await expect(f.service.run(context, { ...f.submit(), parameters: [{ name: "prompt", text: "changed" }] })).rejects.toMatchObject({ code: "AIGC_IDEMPOTENCY_CONFLICT" });
  });

  it("归属校验拒绝其他 Agent 和历史手动任务", async () => {
    const f = await fixture();
    const own = await f.service.run(context, f.submit());
    const manual = await f.tasks.createRun({ interfaceId: f.item.id, inputs: { prompt: "manual" } });
    for (const taskId of [own.taskId, manual.id, "missing"]) {
      await expect(f.service.get({ agentId: "agent-b", sessionId: "other" }, taskId)).rejects.toMatchObject({ code: "AIGC_TASK_NOT_FOUND" });
      await expect(f.service.cancel({ agentId: "agent-b", sessionId: "other" }, taskId)).rejects.toMatchObject({ code: "AIGC_TASK_NOT_FOUND" });
    }
    await expect(f.service.get(context, manual.id)).rejects.toMatchObject({ code: "AIGC_TASK_NOT_FOUND" });
  });

  it("撤销授权和发布立即生效，但撤销发布后仍可取消自己的任务", async () => {
    const f = await fixture(pending);
    const task = await f.service.run(context, f.submit());
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledOnce());
    await f.unpublish();
    await expect(f.service.run(context, f.submit("two"))).rejects.toMatchObject({ code: "AIGC_INTERFACE_UNAVAILABLE" });
    await expect(f.service.get(context, task.taskId)).rejects.toMatchObject({ code: "AIGC_INTERFACE_UNAVAILABLE" });
    expect(await f.service.cancel(context, task.taskId)).toMatchObject({ status: "cancelled", upstreamCancellation: "unknown" });
    f.revoke();
    await expect(f.service.list(context, {})).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
    await expect(f.service.get(context, task.taskId)).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
    await expect(f.service.cancel(context, task.taskId)).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
    await expect(f.service.run(context, f.submit("three"))).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
  });

  it("校验参数失败时不创建任务或调用上游", async () => {
    const f = await fixture();
    for (const parameters of [
      [], [{ name: "prompt", text: "" }], [{ name: "prompt", text: "x", path: "x.png" }],
      [{ name: "prompt", text: "x" }, { name: "prompt", text: "y" }],
      [{ name: "prompt", text: "x" }, { name: "steps", number: 1.5 }],
      [{ name: "agentId", text: "agent-b" }],
    ]) await expect(f.service.run(context, { ...f.submit(), parameters })).rejects.toBeInstanceOf(TypeError);
    expect(await f.tasks.listRecords()).toHaveLength(0);
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it("限制每个 Agent 两个并发任务，并拒绝过频查询", async () => {
    const f = await fixture(pending, {
      maxActiveTasks: 8,
      maxActiveTasksPerAgent: 2,
      maxHourlyTasksPerAgent: 20,
      queryIntervalMs: 2_000,
    });
    const task = await f.service.run(context, f.submit());
    await f.service.run(context, f.submit("two"));
    await expect(f.service.run(context, f.submit("three"))).rejects.toMatchObject({ code: "AIGC_QUOTA_EXCEEDED" });
    await f.service.get(context, task.taskId);
    await expect(f.service.get(context, task.taskId)).rejects.toMatchObject({ code: "AIGC_QUERY_TOO_FREQUENT" });
  });

  it("生成产物同时保留于工作台并仅交付一次到所属工作区", async () => {
    const f = await fixture();
    const task = await f.service.run(context, f.submit());
    await vi.waitFor(async () => expect((await f.tasks.get(task.taskId))?.status).toBe("succeeded"));
    const first = await f.service.get(context, task.taskId);
    expect(first.files).toHaveLength(1);
    expect(first.files[0].path).toMatch(/^attachments\//);
    expect(await readFile(join(f.workspaces, context.agentId, first.files[0].path), "utf8")).toBe("result");
    expect((await f.tasks.get(task.taskId))?.assets).toHaveLength(1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_000);
    const second = await f.service.get(context, task.taskId);
    expect(second.files).toEqual(first.files);
    expect(JSON.stringify(second)).not.toContain(f.root);
  });

  it("工作区媒体拒绝越界、符号链接和错误类型，正确文件进入私有入参区", async () => {
    const f = await fixture();
    await f.interfaces.update(f.item.id, { ...f.item, capability: "image-edit" }, (await f.interfaces.list()).revision);
    await writeFile(join(f.workspaces, "agent-a", "source.png"), "png");
    await writeFile(join(f.workspaces, "agent-a", "source.txt"), "text");
    await symlink(join(f.workspaces, "agent-a", "source.png"), join(f.workspaces, "agent-a", "link.png"));
    for (const path of ["../agent-b/secret.png", "/etc/passwd", "link.png", "source.txt", "missing.png"]) {
      await expect(f.service.run(context, { ...f.submit(), parameters: [{ name: "prompt", text: "x" }, { name: "image", path }] })).rejects.toThrow();
    }
    expect(await f.tasks.listRecords()).toHaveLength(0);
    const task = await f.service.run(context, { ...f.submit(), parameters: [{ name: "prompt", text: "x" }, { name: "image", path: "source.png" }] });
    await vi.waitFor(async () => expect((await f.tasks.get(task.taskId))?.status).toBe("succeeded"));
    const asset = f.adapter.execute.mock.calls[0][0].inputs.image as { assetId: string };
    expect(asset.assetId).toBeTruthy();
    expect(await f.assets.resolveInputPath(asset.assetId)).toBeTruthy();
  });

  it("工具错误不泄露底层绝对路径或凭据", async () => {
    const f = await fixture();
    vi.spyOn(f.service, "list").mockRejectedValue(new Error("Bearer secret /private/path"));
    await expect(f.tools[0].execute("call", {}, undefined, undefined, {} as never)).rejects.toThrow("AIGC_OPERATION_FAILED");
    try { await f.tools[0].execute("call", {}, undefined, undefined, {} as never); } catch (error) {
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain("/private");
    }
  });

  it("重启中断任务不自动重试，历史手动任务不被归入 Agent", async () => {
    const f = await fixture(pending);
    const task = await f.service.run(context, f.submit());
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledOnce());
    const restarted = new AigcTaskRepository(join(f.root, "tasks.json"));
    expect(await restarted.get(task.taskId)).toMatchObject({ status: "failed", error: { code: "AIGC_INTERRUPTED" } });
    expect(f.adapter.execute).toHaveBeenCalledOnce();
  });

  it("取消后迟到的成功响应不能覆盖取消状态或写出产物", async () => {
    let finish: (result: AigcExecutionResult) => void = () => undefined;
    const f = await fixture(async () => new Promise((resolve) => { finish = resolve; }));
    const task = await f.service.run(context, f.submit());
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledOnce());
    const cancellation = f.service.cancel(context, task.taskId);
    await vi.waitFor(() => expect(f.adapter.execute.mock.calls[0][0].signal.aborted).toBe(true));
    finish({ assets: [{ name: "late.png", mediaType: "image/png", content: Buffer.from("late") }] });
    expect(await cancellation).toMatchObject({ status: "cancelled", upstreamCancellation: "unknown" });
    expect((await f.tasks.get(task.taskId))?.assets).toHaveLength(0);
  });

  it("ComfyUI 枚举、布尔、数值范围和默认值按真实字段校验", async () => {
    const f = await fixture();
    const workflow = {
      nodes: [], edges: [], inputMappings: [
        { name: "seed", type: "int", required: true, defaultValue: 10, nodeId: "1", field: "inputs.seed" },
        { name: "mode", type: "enum", enumOptions: [0, 1], required: true, nodeId: "1", field: "inputs.mode" },
        { name: "enabled", type: "bool", required: true, nodeId: "1", field: "inputs.enabled" },
      ],
    } as unknown as AigcWorkflowDetail;
    const fields = agentFields({ ...f.item, protocol: "comfyui" }, workflow);
    expect(validateAgentParameters(fields, [{ name: "mode", number: 0 }, { name: "enabled", boolean: false }])).toEqual({ seed: 10, mode: 0, enabled: false });
    await expect(f.service.run(context, f.submit(), AbortSignal.abort())).rejects.toThrow();
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });
});
