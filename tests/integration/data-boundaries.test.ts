// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/server/database/database";
import { runMigrations } from "../../src/server/database/migrator";
import { createDataPaths } from "../../src/server/paths";

describe("持久化数据所有权", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("SQLite 不接管 Pi 配置或对话正文", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-data-boundaries-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const configurationMarker = "pi-configuration-owned-marker";
    const conversationMarker = "pi-session-owned-marker";
    await writeFile(join(paths.piDir, "settings.json"), JSON.stringify({ marker: configurationMarker }), "utf8");
    await writeFile(join(paths.piDir, "session.jsonl"), JSON.stringify({ message: conversationMarker }), "utf8");

    const database = openDatabase(paths.databaseFile);
    runMigrations(database);
    const tables = database.read<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    database.close();

    expect(tables.map(({ name }) => name)).not.toEqual(expect.arrayContaining(["messages", "model_configs", "credentials"]));
    const databaseBytes = (await readFile(paths.databaseFile)).toString("latin1");
    expect(databaseBytes).not.toContain(configurationMarker);
    expect(databaseBytes).not.toContain(conversationMarker);
    await expect(readFile(join(paths.piDir, "settings.json"), "utf8")).resolves.toContain(configurationMarker);
    await expect(readFile(join(paths.piDir, "session.jsonl"), "utf8")).resolves.toContain(conversationMarker);
  });
});
