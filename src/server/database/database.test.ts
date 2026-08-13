// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database";
import { runMigrations } from "./migrator";

describe("BugPaw SQLite", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("事务失败时不保留部分写入", async () => {
    const database = await createDatabase();

    expect(() => database.transaction(() => {
      database.write("INSERT INTO app_meta(key, value) VALUES (?, ?)", ["a", "1"]);
      throw new Error("boom");
    })).toThrow("boom");

    expect(database.read<{ value: string }>("SELECT value FROM app_meta WHERE key = ?", ["a"])).toEqual([]);
    database.close();
  });

  it("Migration 重复运行只记录一次且重开后数据可读", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-database-"));
    temporaryRoots.push(root);
    const path = join(root, "bugpaw.sqlite3");
    const database = openDatabase(path);

    runMigrations(database);
    runMigrations(database);
    database.write("INSERT INTO app_meta(key, value) VALUES (?, ?)", ["persisted", "yes"]);
    expect(database.read<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    database.close();

    const reopened = openDatabase(path);
    expect(reopened.read<{ value: string }>("SELECT value FROM app_meta WHERE key = ?", ["persisted"])).toEqual([{ value: "yes" }]);
    expect(reopened.read<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    reopened.close();
  });

  it("迁移检索工具权限名称并清除旧名称", () => {
    const database = openDatabase(":memory:");
    runMigrations(database, { throughVersion: 1 });
    const profile = {
      version: 1,
      id: "agent-a",
      name: "Agent A",
      avatar: { kind: "initial", value: "A" },
      description: "",
      status: "active",
      cwd: "/tmp/agent-a",
      instructions: { role: "", behavior: "", rules: "", user: "" },
      allowedTools: ["read", "search_knowledge", "get_knowledge_document", "manage_knowledge_base", "web_search", "web_open"],
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    };
    database.write(
      "INSERT INTO agents(id, cwd, profile_json, sort_order, revision, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)",
      [profile.id, profile.cwd, JSON.stringify(profile), profile.createdAt, profile.updatedAt],
    );

    runMigrations(database);

    const row = database.readOne<{ profile_json: string }>("SELECT profile_json FROM agents WHERE id = ?", [profile.id]);
    expect(JSON.parse(row!.profile_json).allowedTools).toEqual([
      "read",
      "knowledge_search",
      "knowledge_read",
      "knowledge_manage",
      "web_search",
      "web_read",
    ]);
    expect(database.read<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    database.close();
  });

  it("为已有 Session 增加空的置顶状态", () => {
    const database = openDatabase(":memory:");
    runMigrations(database, { throughVersion: 3 });
    database.write(
      "INSERT INTO agents(id, cwd, profile_json, sort_order, revision, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)",
      ["agent-1", "/data/workspace/agent-1", "{}", "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z"],
    );
    database.write(
      "INSERT INTO sessions(id, agent_id, projection_version, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
      ["session-1", "agent-1", "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z"],
    );

    runMigrations(database);

    expect(database.readOne<{ pinned_at: string | null }>(
      "SELECT pinned_at FROM sessions WHERE id = ?",
      ["session-1"],
    )).toEqual({ pinned_at: null });
    database.close();
  });

  it("启用外键、WAL 和五秒 busy timeout", async () => {
    const database = await createDatabase();

    expect(database.read<{ foreign_keys: number }>("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(database.read<{ journal_mode: string }>("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
    expect(database.read<{ timeout: number }>("PRAGMA busy_timeout")).toEqual([{ timeout: 5_000 }]);
    database.close();
  });

  async function createDatabase() {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-database-"));
    temporaryRoots.push(root);
    const database = openDatabase(join(root, "bugpaw.sqlite3"));
    runMigrations(database);
    return database;
  }
});
