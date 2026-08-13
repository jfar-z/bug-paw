// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDataPaths } from "../paths";
import { createWorkspaceFileService } from "../attachments";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { createAgentRepository } from "./agent-repository";
import { AgentStore } from "./agent-store";

describe("AgentStore", () => {
  const roots: string[] = [];

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-store-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    return { root, paths, store: new AgentStore(paths) };
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("创建不可预测 ID 和唯一 cwd，重命名不改变工作目录", async () => {
    const { store } = await fixture();
    const first = await store.create({ name: "研究助手" });
    const second = await store.create({ name: "研究助手" });

    expect(first.profile.id).not.toBe(second.profile.id);
    expect(first.profile.cwd).not.toBe(second.profile.cwd);
    const updated = await store.update(first.profile.id, { name: "新名称" }, first.revision);
    expect(updated.profile.cwd).toBe(first.profile.cwd);
    expect(await store.resolveWorkspace(first.profile.id)).toBe(first.profile.cwd);
  });

  it("Profile 只保存在 SQLite，重建服务后仍可读取", async () => {
    const { paths, store } = await fixture();
    const created = await store.create({ name: "持久化助手" });

    await expect(stat(join(paths.agentsDir, created.profile.id, "profile.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new AgentStore(paths).get(created.profile.id)).resolves.toMatchObject({
      profile: { id: created.profile.id, name: "持久化助手" },
      revision: "1",
    });
  });

  it("补齐历史 Agent 的系统工具权限且不移除既有选择", async () => {
    const { store } = await fixture();
    const created = await store.create({ name: "历史 Agent", allowedTools: ["read"] });

    await store.ensureSystemToolPermissions(["knowledge_search", "scheduled_tasks"]);

    expect((await store.get(created.profile.id))?.profile.allowedTools).toEqual([
      "read",
      "knowledge_search",
      "scheduled_tasks",
    ]);
  });

  it("幂等移除废弃工具权限并保持其他权限顺序", async () => {
    const { store } = await fixture();
    const withRetired = await store.create({
      name: "旧 Agent",
      allowedTools: ["read", "edit_own_prompts", "write", "extension_lookup"],
    });
    const unchanged = await store.create({ name: "新 Agent", allowedTools: ["read", "write"] });

    await store.removeToolPermissions(["edit_own_prompts"]);

    expect((await store.get(withRetired.profile.id))?.profile.allowedTools)
      .toEqual(["read", "write", "extension_lookup"]);
    expect((await store.get(unchanged.profile.id))?.revision).toBe(unchanged.revision);

    const cleanedRevision = (await store.get(withRetired.profile.id))?.revision;
    expect(Number(cleanedRevision)).toBe(Number(withRetired.revision) + 1);
    await store.removeToolPermissions(["edit_own_prompts"]);
    expect((await store.get(withRetired.profile.id))?.revision).toBe(cleanedRevision);
  });

  it("保存指定 Agent 顺序，并把未收录 Agent 稳定追加", async () => {
    const { store } = await fixture();
    const first = await store.create({ name: "First" });
    const second = await store.create({ name: "Second" });
    const third = await store.create({ name: "Third" });

    await store.reorder([second.profile.id, first.profile.id]);

    await expect(store.list()).resolves.toMatchObject([
      { profile: { id: second.profile.id } },
      { profile: { id: first.profile.id } },
      { profile: { id: third.profile.id } },
    ]);
  });

  it("创建 Agent 时采用自定义 cwd 并保留已有 .pi", async () => {
    const { paths, store } = await fixture();
    const custom = join(paths.workspaceDir, "projects", "demo");
    await mkdir(join(custom, ".pi"), { recursive: true });
    await writeFile(join(custom, ".pi", "settings.json"), "{}\n", "utf8");

    const created = await store.create({ name: "项目助手", cwd: custom });

    expect(created.profile.cwd).toBe(custom);
    expect(await store.resolveWorkspace(created.profile.id)).toBe(custom);
    await expect(readFile(join(custom, ".pi", "settings.json"), "utf8")).resolves.toBe("{}\n");
  });

  it("拒绝把 Pi 配置、应用数据库或 workspace 根目录作为 Agent cwd", async () => {
    const { paths, store } = await fixture();

    await expect(store.create({ name: "Pi", cwd: paths.piDir })).rejects.toMatchObject({ code: "WORKSPACE_OUTSIDE_DATA" });
    await expect(store.create({ name: "App", cwd: paths.appDir })).rejects.toMatchObject({ code: "WORKSPACE_OUTSIDE_DATA" });
    await expect(store.create({ name: "Root", cwd: paths.workspaceDir })).rejects.toMatchObject({ code: "WORKSPACE_ROOT_FORBIDDEN" });
  });

  it("拒绝两个 Agent 使用同一工作目录", async () => {
    const { paths, store } = await fixture();
    const custom = join(paths.workspaceDir, "projects", "shared");
    await store.create({ name: "A", cwd: custom });

    await expect(store.create({ name: "B", cwd: custom }))
      .rejects.toMatchObject({ code: "WORKSPACE_IN_USE" });
  });

  it("并发创建同一 cwd 只有一个成功且不会清理胜出者目录", async () => {
    const { paths, store } = await fixture();
    const custom = join(paths.workspaceDir, "projects", "concurrent");

    const results = await Promise.allSettled([
      store.create({ name: "A", cwd: custom }),
      store.create({ name: "B", cwd: custom }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(stat(custom)).resolves.toMatchObject({});
  });

  it("拒绝工作目录形成祖先或子目录重叠", async () => {
    const { paths, store } = await fixture();
    const parent = join(paths.workspaceDir, "projects", "parent");
    await store.create({ name: "A", cwd: parent });

    await expect(store.create({ name: "B", cwd: join(parent, "child") }))
      .rejects.toMatchObject({ code: "WORKSPACE_IN_USE" });
    await expect(store.create({ name: "C", cwd: join(paths.workspaceDir, "projects") }))
      .rejects.toMatchObject({ code: "WORKSPACE_IN_USE" });
  });

  it("切换 cwd 时只迁移 .pi 并保留旧目录其他文件", async () => {
    const { paths, store } = await fixture();
    const created = await store.create({ name: "A" });
    await mkdir(join(created.profile.cwd, ".pi"), { recursive: true });
    await writeFile(join(created.profile.cwd, ".pi", "persona.md"), "角色", "utf8");
    await writeFile(join(created.profile.cwd, "project.txt"), "源码", "utf8");
    const target = join(paths.workspaceDir, "projects", "target");

    const updated = await store.update(created.profile.id, { cwd: target }, created.revision);

    expect(updated.profile.cwd).toBe(target);
    await expect(readFile(join(target, ".pi", "persona.md"), "utf8")).resolves.toBe("角色");
    await expect(readFile(join(created.profile.cwd, "project.txt"), "utf8")).resolves.toBe("源码");
    await expect(stat(join(created.profile.cwd, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("目标已有 .pi 时拒绝切换且不修改两端和 Profile", async () => {
    const { paths, store } = await fixture();
    const created = await store.create({ name: "A" });
    await mkdir(join(created.profile.cwd, ".pi"), { recursive: true });
    await writeFile(join(created.profile.cwd, ".pi", "source.md"), "source", "utf8");
    const target = join(paths.workspaceDir, "projects", "occupied");
    await mkdir(join(target, ".pi"), { recursive: true });
    await writeFile(join(target, ".pi", "target.md"), "target", "utf8");

    await expect(store.update(created.profile.id, { cwd: target }, created.revision))
      .rejects.toMatchObject({ code: "WORKSPACE_PI_CONFLICT" });

    expect((await store.get(created.profile.id))?.profile.cwd).toBe(created.profile.cwd);
    await expect(readFile(join(created.profile.cwd, ".pi", "source.md"), "utf8")).resolves.toBe("source");
    await expect(readFile(join(target, ".pi", "target.md"), "utf8")).resolves.toBe("target");
  });

  it("旧目录没有 .pi 时直接切换且不创建新 .pi", async () => {
    const { paths, store } = await fixture();
    const created = await store.create({ name: "A" });
    const target = join(paths.workspaceDir, "projects", "empty-target");

    const updated = await store.update(created.profile.id, { cwd: target }, created.revision);

    expect(updated.profile.cwd).toBe(target);
    await expect(stat(target)).resolves.toMatchObject({});
    await expect(stat(join(target, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("历史默认 Agent 可像普通 Agent 一样修改工作目录", async () => {
    const { paths, store } = await fixture();
    const defaultAgent = await store.createDefault();
    const target = join(paths.workspaceDir, "projects", "legacy-default");

    const updated = await store.update("default", { cwd: target }, defaultAgent.revision);

    expect(updated.profile.cwd).toBe(target);
    expect(await store.resolveWorkspace("default")).toBe(target);
  });

  it("Profile 版本冲突时把 .pi 回滚到旧目录", async () => {
    const { paths, store } = await fixture();
    const created = await store.create({ name: "A" });
    await mkdir(join(created.profile.cwd, ".pi"), { recursive: true });
    await writeFile(join(created.profile.cwd, ".pi", "persona.md"), "角色", "utf8");
    const renamed = await store.update(created.profile.id, { name: "新版" }, created.revision);
    const target = join(paths.workspaceDir, "projects", "stale-target");

    await expect(store.update(created.profile.id, { cwd: target }, created.revision)).rejects.toThrow();

    expect((await store.get(created.profile.id))?.revision).toBe(renamed.revision);
    expect((await store.get(created.profile.id))?.profile.cwd).toBe(created.profile.cwd);
    await expect(readFile(join(created.profile.cwd, ".pi", "persona.md"), "utf8")).resolves.toBe("角色");
    await expect(stat(join(target, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("旧 Profile 未手动迁移 Markdown 时不把嵌入提示词作为事实来源", async () => {
    const { paths, store } = await fixture();
    const created = await store.create({ name: "兼容助手" });
    const legacyInstructions = {
      role: "角色内容",
      behavior: "行为内容",
      principles: "先验证事实",
      rules: "必须记录结果",
      prohibitions: "禁止泄露凭证",
      longTermDirection: "持续改进",
      user: "偏好中文",
    };
    await writeFile(
      join(paths.agentsDir, created.profile.id, "profile.json"),
      `${JSON.stringify({ ...created.profile, instructions: legacyInstructions })}\n`,
      "utf8",
    );

    const loaded = await store.get(created.profile.id);

    expect(loaded?.profile.instructions).toEqual({ role: "", behavior: "", rules: "", user: "" });
  });

  it("拒绝越界 cwd 和两个 Agent 共用目录，同时兼容默认工作目录", async () => {
    const { paths, store } = await fixture();
    await store.createDefault();
    expect(await store.resolveWorkspace("default")).toBe(join(paths.workspaceDir, "agents", "default"));

    const first = await store.create({ name: "A" });
    await expect(store.create({ name: "越界", cwd: "../outside" })).rejects.toThrow("工作目录");
    await expect(store.create({ name: "重复", cwd: first.profile.cwd })).rejects.toThrow("占用");
  });

  it("归档后禁止创建 Session，恢复后重新允许", async () => {
    const { store } = await fixture();
    const created = await store.create({ name: "A" });

    const archived = await store.archive(created.profile.id, created.revision);
    await expect(store.assertCanCreateSession(created.profile.id)).rejects.toMatchObject({ code: "AGENT_ARCHIVED" });
    const restored = await store.restore(created.profile.id, archived.revision);
    await expect(store.assertCanCreateSession(created.profile.id)).resolves.toBeUndefined();
    expect(restored.profile.status).toBe("active");
  });

  it("不存在的 Agent 使用稳定领域错误码", async () => {
    const { store } = await fixture();

    await expect(store.resolveWorkspace("missing")).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("克隆默认创建空目录，复制时拒绝越界符号链接", async () => {
    const { root, store } = await fixture();
    const source = await store.create({ name: "A" });
    await writeFile(join(source.profile.cwd, "note.txt"), "content", "utf8");
    const emptyClone = await store.clone(source.profile.id, { name: "空克隆" });
    await expect(stat(join(emptyClone.profile.cwd, "note.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(source.profile.cwd, "outside-link.txt"));
    await expect(store.clone(source.profile.id, { name: "复制克隆", copyWorkspace: true })).rejects.toThrow("符号链接");
  });

  it("更新和克隆时保留标题生成策略，并允许清除", async () => {
    const { store } = await fixture();
    const created = await store.create({ name: "标题 Agent", titleGeneration: {
      modelSource: "custom",
      model: { provider: "OpenAI", id: "gpt-title" },
      thinkingEnabled: true,
    } });

    const cloned = await store.clone(created.profile.id, { name: "标题副本" });
    expect(cloned.profile.titleGeneration).toEqual(created.profile.titleGeneration);

    const cleared = await store.update(created.profile.id, { titleGeneration: null }, created.revision);
    expect(cleared.profile.titleGeneration).toBeUndefined();
  });

  it("附件服务通过 AgentStore 使用每个 Agent 的固定 cwd", async () => {
    const { paths, store } = await fixture();
    const created = await store.create({ name: "A" });
    const files = createWorkspaceFileService(paths, store);

    const saved = await files.saveUpload(created.profile.id, "note.txt", "text/plain", Readable.from("agent file"));

    expect(saved.absolutePath).toBe(join(created.profile.cwd, "attachments", "note.txt"));
  });

  it("删除 Profile、Session 和 cwd 选项相互独立且 cwd 进入回收区", async () => {
    const { paths } = await fixture();
    const commit = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    const stageSessions = vi.fn(async () => ({ commit, rollback }));
    const store = new AgentStore(paths, { stageSessions });
    const kept = await store.create({ name: "保留数据" });
    await writeFile(join(kept.profile.cwd, "keep.txt"), "keep", "utf8");
    await store.remove(kept.profile.id, { removeSessions: false, removeWorkspace: false });
    expect(stageSessions).not.toHaveBeenCalled();
    await expect(stat(kept.profile.cwd)).resolves.toMatchObject({});
    await expect(store.get(kept.profile.id)).resolves.toBeUndefined();

    const removed = await store.create({ name: "移除数据" });
    const result = await store.remove(removed.profile.id, { removeSessions: true, removeWorkspace: true });
    expect(stageSessions).toHaveBeenCalledWith(removed.profile.id);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(result.trashPath).toContain(join(paths.trashDir, "agents"));
    await expect(stat(result.trashPath!)).resolves.toMatchObject({});
    await expect(stat(removed.profile.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("数据库删除失败时恢复已暂存的 Session、Agent 数据和工作目录", async () => {
    const { paths } = await fixture();
    const database = openDatabase(paths.databaseFile);
    runMigrations(database);
    const repository = createAgentRepository(database);
    const rollback = vi.fn(async () => undefined);
    const store = new AgentStore(paths, {
      stageSessions: vi.fn(async () => ({ commit: vi.fn(async () => undefined), rollback })),
    }, {
      ...repository,
      remove: vi.fn(async () => {
        throw new Error("模拟数据库删除失败");
      }),
    });
    const created = await store.create({ name: "回滚助手" });
    await writeFile(join(created.profile.cwd, "keep.txt"), "keep", "utf8");

    await expect(store.remove(created.profile.id, { removeSessions: true, removeWorkspace: true }))
      .rejects.toThrow("模拟数据库删除失败");

    expect(rollback).toHaveBeenCalledOnce();
    await expect(store.get(created.profile.id)).resolves.toBeDefined();
    await expect(readFile(join(created.profile.cwd, "keep.txt"), "utf8")).resolves.toBe("keep");
    await expect(stat(join(paths.agentsDir, created.profile.id))).resolves.toMatchObject({});
    database.close();
  });
});
