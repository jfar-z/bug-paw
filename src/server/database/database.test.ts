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
    expect(database.read<{ version: number }>("SELECT version FROM schema_migrations")).toEqual([{ version: 1 }]);
    database.close();

    const reopened = openDatabase(path);
    expect(reopened.read<{ value: string }>("SELECT value FROM app_meta WHERE key = ?", ["persisted"])).toEqual([{ value: "yes" }]);
    reopened.close();
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
