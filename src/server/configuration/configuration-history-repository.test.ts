// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "../database/database";
import { createTestDatabase } from "../database/test-database";
import { createConfigurationHistoryRepository } from "./configuration-history-repository";

describe("ConfigurationHistoryRepository", () => {
  const databases: Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it("按时间倒序保存脱敏元数据与快照索引", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const repository = createConfigurationHistoryRepository(database);
    await repository.append({ id: "h1", revision: "r1", snapshotPath: "/snapshots/h1.json", createdAt: "2026-08-07T00:00:00.000Z" });
    await repository.append({ id: "h2", revision: "r2", snapshotPath: "/snapshots/h2.json", createdAt: "2026-08-07T01:00:00.000Z" });

    expect((await repository.list()).map(({ id }) => id)).toEqual(["h2", "h1"]);
    expect(await repository.find("h1")).toMatchObject({ revision: "r1" });
  });

  it("只保留指定数量的最新索引", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const repository = createConfigurationHistoryRepository(database);
    for (let index = 1; index <= 4; index += 1) {
      await repository.append({ id: `h${index}`, revision: `r${index}`, snapshotPath: `/snapshots/h${index}.json`, createdAt: `2026-08-07T0${index}:00:00.000Z` });
    }

    await repository.prune(2);

    expect((await repository.list()).map(({ id }) => id)).toEqual(["h4", "h3"]);
  });
});
