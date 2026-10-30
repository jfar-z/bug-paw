// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { migrateWorkflowStorage } from "./migrate-workflow-storage";
import { openDatabase } from "../src/server/database/database";
import { runMigrations } from "../src/server/database/migrator";
import { AigcWorkflowService } from "../src/server/aigc/aigc-workflow-service";
import { WorkflowRepository } from "../src/server/workflows/workflow-repository";
import { emptyWorkflow } from "../src/shared/workflow-contracts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** 模拟尚未升级的生产目录，使用合成定义避免复制生产敏感内容。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workflow-migration-"));
  roots.push(root);
  const dataDir = join(root, "data"), app = join(dataDir, "app"), backupDir = join(root, "backup");
  await mkdir(join(app, "workflows", "runs"), { recursive: true });
  const database = openDatabase(join(app, "bugpaw.sqlite3"));
  runMigrations(database, { throughVersion: 7 });
  database.close();
  const comfy = { id: "comfy-1", name: "示例", fileName: "example.json", originalHash: "original",
    raw: { "1": { class_type: "SaveImage", inputs: {} } }, nodes: [{ id: "1", type: "SaveImage", fields: [] }], edges: [],
    inputMappings: [], outputMappings: [], createdAt: "2026-10-30", updatedAt: "2026-10-30" };
  const dag = { ...emptyWorkflow(), id: "dag-1", revision: 3, createdAt: "2026-10-30", updatedAt: "2026-10-30" };
  await writeFile(join(app, "aigc-workflows.json"), JSON.stringify({ workflows: [comfy] }));
  await writeFile(join(app, "workflows", "definitions.json"), JSON.stringify([dag]));
  await writeFile(join(app, "workflows", "runs", "run-1.json"), JSON.stringify({ definition: dag }));
  await writeFile(join(app, "aigc-interfaces.json"), JSON.stringify({ interfaces: [{ protocol: "comfyui", config: { workflowId: comfy.id } }] }));
  return { root, app, comfy, dag, options: { dataDir, backupDir, apply: true } };
}

describe("独立工作流迁移", () => {
  it("预检不写数据，备份后迁移两类定义并保留原 ID、正文和运行快照", async () => {
    const f = await fixture();
    expect(await migrateWorkflowStorage({ ...f.options, apply: false })).toEqual({ comfyui: 1, dag: 1, applied: false });
    await expect(stat(f.options.backupDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await migrateWorkflowStorage(f.options)).toEqual({ comfyui: 1, dag: 1, applied: true });
    expect(JSON.parse(await readFile(join(f.app, "aigc-workflows", "definitions", "comfy-1.json"), "utf8"))).toEqual(f.comfy);
    expect(JSON.parse(await readFile(join(f.app, "workflows", "definitions", "dag-1.json"), "utf8"))).toEqual(f.dag);
    expect(await readFile(join(f.app, "workflows", "runs", "run-1.json"), "utf8")).toBe(await readFile(join(f.options.backupDir, "dag-runs", "run-1.json"), "utf8"));
    await expect(stat(join(f.app, "aigc-workflows.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(f.options.backupDir, "bugpaw.sqlite3"))).mode & 0o777).toBe(0o600);
    const before = openDatabase(join(f.options.backupDir, "bugpaw.sqlite3"));
    expect(before.readOne<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")?.version).toBe(7);
    before.close();
    const database = openDatabase(join(f.app, "bugpaw.sqlite3"));
    const comfyService = new AigcWorkflowService(join(f.app, "aigc-workflows", "definitions"), database);
    expect((await comfyService.list()).workflows[0].id).toBe(f.comfy.id);
    expect((await comfyService.getPrivate(f.comfy.id))?.raw).toEqual(f.comfy.raw);
    const dagRepository = new WorkflowRepository(join(f.app, "workflows"), database);
    expect(dagRepository.definitions()[0]).not.toHaveProperty("nodes");
    expect(dagRepository.definition(f.dag.id)).toEqual(f.dag);
    database.close();
    await expect(migrateWorkflowStorage({ ...f.options, backupDir: join(f.root, "second") })).rejects.toThrow("未找到旧工作流文件");
  });

  it("正常应用建表不自动搬运旧数据", async () => {
    const f = await fixture();
    const database = openDatabase(join(f.app, "bugpaw.sqlite3"));
    runMigrations(database);
    expect(new WorkflowRepository(join(f.app, "workflows"), database).definitions()).toEqual([]);
    expect((await new AigcWorkflowService(join(f.app, "aigc-workflows", "definitions"), database).list()).workflows).toEqual([]);
    expect(JSON.parse(await readFile(join(f.app, "workflows", "definitions.json"), "utf8"))).toEqual([f.dag]);
    database.close();
  });

  it("重复 ID、已有不同目标和在线实例锁均在写入前拒绝", async () => {
    const f = await fixture();
    await mkdir(join(f.app, ".bugpaw-instance.lock"));
    await expect(migrateWorkflowStorage(f.options)).rejects.toThrow("停止 BugPaw");
    await rm(join(f.app, ".bugpaw-instance.lock"), { recursive: true });
    await writeFile(join(f.app, "workflows", "definitions.json"), JSON.stringify([f.dag, f.dag]));
    await expect(migrateWorkflowStorage(f.options)).rejects.toThrow("非法或重复");
    await writeFile(join(f.app, "workflows", "definitions.json"), JSON.stringify([f.dag]));
    await mkdir(join(f.app, "workflows", "definitions"));
    await writeFile(join(f.app, "workflows", "definitions", "dag-1.json"), "{}");
    await expect(migrateWorkflowStorage(f.options)).rejects.toThrow("拒绝覆盖");
    await expect(stat(f.options.backupDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
