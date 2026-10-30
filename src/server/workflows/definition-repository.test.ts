// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../database/test-database";
import { DefinitionRepository } from "./definition-repository";
import { AigcWorkflowService } from "../aigc/aigc-workflow-service";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** 独立文件和真实 SQLite 用于注入事务失败及进程中断状态。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-files-"));
  roots.push(root);
  const database = createTestDatabase();
  const store = new DefinitionRepository(database, "dag", root, (value: { id: string; name: string; nodes: string[] }) => ({ id: value.id, name: value.name }));
  return { root, database, store };
}

describe("工作流定义独立存储", () => {
  it("列表仅查数据库；一个文件损坏或缺失不影响其他定义", () => {
    const { root, store } = fixture();
    store.save({ id: "first", name: "一", nodes: ["秘密脚本"] });
    const revision = store.save({ id: "second", name: "二", nodes: [] });
    writeFileSync(join(root, "first.json"), "invalid", "utf8");
    expect(store.list().items).toEqual([{ id: "first", name: "一" }, { id: "second", name: "二" }]);
    expect(() => store.get("first")).toThrow("不是有效 JSON");
    expect(store.get("second")?.name).toBe("二");
    rmSync(join(root, "first.json"));
    expect(() => store.get("first")).toThrow("定义文件缺失");
    expect(() => store.save({ id: "second", name: "旧写入", nodes: [] }, "0")).toThrow("其他操作修改");
    store.remove("first", revision);
    expect(store.list().items).toHaveLength(1);
  });

  it("手工编辑下次读取生效，拒绝 ID 不一致、路径穿越和符号链接", () => {
    const { root, store } = fixture();
    store.save({ id: "manual", name: "原版", nodes: [] });
    writeFileSync(join(root, "manual.json"), JSON.stringify({ id: "manual", name: "手改", nodes: ["new"] }));
    expect(store.get("manual")).toMatchObject({ name: "手改", nodes: ["new"] });
    expect(() => store.get("../outside")).toThrow("工作流 ID");
    writeFileSync(join(root, "manual.json"), JSON.stringify({ id: "other" }));
    expect(() => store.get("manual")).toThrow("与 ID 不一致");
    rmSync(join(root, "manual.json"));
    symlinkSync(join(root, "other.json"), join(root, "manual.json"));
    expect(() => store.get("manual")).toThrow("普通文件");
  });

  it.each(["save", "remove"] as const)("数据库提交失败时恢复 %s 前的原文件和索引", (operation) => {
    const { root, store, database } = fixture();
    store.save({ id: "one", name: "原版", nodes: [] });
    const before = readFileSync(join(root, "one.json"), "utf8");
    const revision = store.list().revision;
    const write = database.write.bind(database);
    vi.spyOn(database, "write").mockImplementation((sql, values) => {
      if (sql.includes("workflow_index_state")) throw new Error("注入数据库写入失败");
      return write(sql, values);
    });
    expect(() => operation === "save" ? store.save({ id: "one", name: "新版", nodes: [] }) : store.remove("one")).toThrow("注入数据库写入失败");
    expect(readFileSync(join(root, "one.json"), "utf8")).toBe(before);
    expect(store.list()).toEqual({ revision, items: [{ id: "one", name: "原版" }] });
    expect(existsSync(join(root, ".pending.json"))).toBe(false);
  });

  it.each([false, true])("进程中断后按数据库提交标记恢复，已提交=%s", (committed) => {
    const { root, store, database } = fixture();
    store.save({ id: "one", name: "原版", nodes: [] });
    const before = readFileSync(join(root, "one.json"), "utf8");
    writeFileSync(join(root, ".pending.json"), JSON.stringify({ id: "one", before, revision: "pending" }));
    writeFileSync(join(root, "one.json"), JSON.stringify({ id: "one", name: "新版", nodes: [] }));
    if (committed) database.write("UPDATE workflow_index_state SET revision='pending' WHERE kind='dag'");
    expect(store.get("one")?.name).toBe(committed ? "新版" : "原版");
    expect(existsSync(join(root, ".pending.json"))).toBe(false);
  });

  it("ComfyUI 手改 raw 后重新解析节点和连线，其他工作流文件保持原字节", async () => {
    const { root, database } = fixture();
    const service = new AigcWorkflowService(root, database);
    const input = { name: "图像", fileName: "sample.json", workflowJson: { "1": { class_type: "SaveImage", inputs: {} } }, inputMappings: [], outputMappings: [] };
    const first = await service.create(input);
    const second = await service.create(input);
    const untouched = readFileSync(join(root, `${second.workflow.id}.json`), "utf8");
    const path = join(root, `${first.workflow.id}.json`);
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.raw["2"] = { class_type: "SaveImage", inputs: { images: ["1", 0] } };
    writeFileSync(path, JSON.stringify(value));
    expect((await service.get(first.workflow.id)).workflow.nodes).toHaveLength(2);
    expect((await service.getPrivate(first.workflow.id))?.edges).toHaveLength(1);
    expect(readFileSync(join(root, `${second.workflow.id}.json`), "utf8")).toBe(untouched);
  });
});
