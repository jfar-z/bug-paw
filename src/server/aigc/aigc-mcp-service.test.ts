// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AigcTaskRecord } from "../../shared/aigc-contracts";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { AigcMcpService } from "./aigc-mcp-service";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** 令牌与任务归属使用真实数据库，生成上游以可观察的存根代替。 */
describe("AIGC MCP 服务", () => {
  it("创建的令牌只显示一次，撤销后立即失效", async () => {
    const fixture = await createFixture();
    try {
      const issued = await fixture.service.create({ name: "外部绘图", interfaceIds: ["interface-1"], operations: ["list", "run"] });
      expect(issued.token).toMatch(/^bpmcp_/);
      expect(fixture.service.listClients()[0]).not.toHaveProperty("token");
      expect(fixture.service.authenticate(issued.token)?.id).toBe(issued.client.id);
      expect(fixture.service.authenticate("invalid")).toBeUndefined();
      await fixture.service.revoke(issued.client.id);
      expect(fixture.service.authenticate(issued.token)).toBeUndefined();
      await expect(fixture.service.list(issued.client, { offset: 0 })).rejects.toMatchObject({ code: "MCP_ACCESS_DENIED" });
    } finally { fixture.close(); }
  });

  it("重复请求不会重复创建任务，其他客户端不能读取任务", async () => {
    const fixture = await createFixture();
    try {
      const first = (await fixture.service.create({ name: "客户端一", interfaceIds: ["interface-1"], operations: ["run", "get"] })).client;
      const second = (await fixture.service.create({ name: "客户端二", interfaceIds: ["interface-1"], operations: ["run", "get"] })).client;
      const input = { interfaceId: "interface-1", requestKey: "cover-1", parameters: [{ name: "prompt", value: "封面" }] };
      const created = await fixture.service.run(first, input);
      expect((await fixture.service.run(first, input)).taskId).toBe(created.taskId);
      expect(fixture.createRun).toHaveBeenCalledTimes(1);
      await expect(fixture.service.run(first, { ...input, parameters: [{ name: "prompt", value: "其他封面" }] }))
        .rejects.toMatchObject({ code: "MCP_IDEMPOTENCY_CONFLICT" });
      await expect(fixture.service.get(second, created.taskId)).rejects.toMatchObject({ code: "MCP_TASK_NOT_FOUND" });
      expect((await fixture.service.get(first, created.taskId)).status).toBe("queued");
    } finally { fixture.close(); }
  });

  it("媒体上传和产物读取均限制在客户端归属内", async () => {
    const fixture = await createFixture();
    try {
      const operations = ["run", "upload", "get", "download"] as const;
      const first = (await fixture.service.create({ name: "客户端一", interfaceIds: ["interface-1"], operations: [...operations] })).client;
      const second = (await fixture.service.create({ name: "客户端二", interfaceIds: ["interface-1"], operations: [...operations] })).client;
      const upload = await fixture.service.upload(first, Readable.from(Buffer.from("image")), "reference.png", "image/png");
      const input = { interfaceId: "interface-1", requestKey: "image-1", parameters: [
        { name: "prompt", value: "编辑图片" }, { name: "image", value: upload.inputId },
      ] };
      await expect(fixture.service.run(second, input)).rejects.toMatchObject({ code: "MCP_INPUT_NOT_FOUND" });
      const submitted = await fixture.service.run(first, input);
      expect(fixture.records[0].inputs.image).toMatchObject({ assetId: upload.inputId });
      fixture.records[0].status = "succeeded";
      fixture.records[0].assets = [{ id: "output-1", name: "result.png", mediaType: "image/png", size: 6,
        outputId: "result", outputName: "result", createdAt: new Date().toISOString() }];
      const result = await fixture.service.get(first, submitted.taskId);
      expect(result.files[0].downloadPath).toContain("/api/v1/aigc/mcp/tasks/");
      expect((await fixture.service.readSmallOutput(first, submitted.taskId, "output-1")).base64).toBe(Buffer.from("output").toString("base64"));
      await expect(fixture.service.output(second, submitted.taskId, "output-1")).rejects.toMatchObject({ code: "MCP_TASK_NOT_FOUND" });
    } finally { fixture.close(); }
  });

  it("图片编辑接受有序 inputId 列表，并逐个校验客户端归属", async () => {
    const fixture = await createFixture();
    try {
      const operations = ["list", "run", "upload"] as const;
      const first = (await fixture.service.create({ name: "客户端一", interfaceIds: ["interface-1"], operations: [...operations] })).client;
      const second = (await fixture.service.create({ name: "客户端二", interfaceIds: ["interface-1"], operations: [...operations] })).client;
      const firstImage = await fixture.service.upload(first, Readable.from("first"), "first.png", "image/png");
      const secondImage = await fixture.service.upload(first, Readable.from("second"), "second.png", "image/png");
      const foreignImage = await fixture.service.upload(second, Readable.from("foreign"), "foreign.png", "image/png");
      const detail = await fixture.service.list(first, { interfaceId: "interface-1" });
      expect(detail.interfaces[0]).toHaveProperty("fields", expect.arrayContaining([
        expect.objectContaining({ name: "image", source: "upload", multiple: true, maxItems: 16 }),
      ]));
      const parameters = [{ name: "prompt", value: "组合" }, { name: "image", value: [firstImage.inputId, secondImage.inputId] }];
      await fixture.service.run(first, { interfaceId: "interface-1", requestKey: "multi", parameters });
      expect((fixture.records[0].inputs.image as { assetId: string }[]).map((asset) => asset.assetId))
        .toEqual([firstImage.inputId, secondImage.inputId]);
      await expect(fixture.service.run(first, { interfaceId: "interface-1", requestKey: "foreign",
        parameters: [{ name: "prompt", value: "组合" }, { name: "image", value: [firstImage.inputId, foreignImage.inputId] }],
      })).rejects.toMatchObject({ code: "MCP_INPUT_NOT_FOUND" });
      await fixture.service.revoke(first.id);
      expect(fixture.removeInput).not.toHaveBeenCalled();
    } finally { fixture.close(); }
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-mcp-test-"));
  roots.push(root);
  const database = openDatabase(join(root, "test.sqlite3"));
  runMigrations(database);
  const item = { id: "interface-1", name: "图片", description: "图片生成", protocol: "openai", capability: "image-edit",
    channelId: "channel-1", enabled: true, toolPublishEnabled: false, mcpPublishEnabled: true, config: { model: "gpt-image" },
    createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
  const records: AigcTaskRecord[] = [];
  const removeInput = vi.fn(async () => undefined);
  const createRun = vi.fn(async (request: { inputs: AigcTaskRecord["inputs"] }, _agentOrigin: unknown, mcpOrigin: AigcTaskRecord["mcpOrigin"]) => {
    const task: AigcTaskRecord = { id: `task-${records.length + 1}`, interfaceId: item.id, interfaceName: item.name,
      channelId: item.channelId, status: "queued", inputs: request.inputs, assets: [], mcpOrigin,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    records.push(task);
    return task;
  });
  const service = new AigcMcpService({ database,
    interfaces: { get: async (id: string) => id === item.id ? item : undefined } as never,
    connections: { read: async () => ({ channels: [{ id: "channel-1", enabled: true, type: "openai" }] }) } as never,
    workflows: {} as never,
    assets: { saveInput: vi.fn().mockImplementationOnce(async () => ({ id: "input-1", name: "reference.png", mediaType: "image/png", size: 5 }))
      .mockImplementationOnce(async () => ({ id: "input-2", name: "second.png", mediaType: "image/png", size: 6 }))
      .mockImplementationOnce(async () => ({ id: "input-3", name: "foreign.png", mediaType: "image/png", size: 7 })),
      resolveInputPath: async (id: string) => ["input-1", "input-2", "input-3"].includes(id) ? `/private/${id}` : undefined,
      resolveOutputPath: async (_taskId: string, id: string) => id === "output-1" ? "/private/output-1" : undefined,
      readOutput: async () => Buffer.from("output"), removeInput } as never,
    publicFiles: {} as never,
    tasks: { listRecords: async () => records, createRun, get: async (id: string) => records.find((task) => task.id === id) } as never,
  });
  return { service, createRun, records, removeInput, close: () => database.close() };
}
