// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "../database/database";
import { createTestDatabase } from "../database/test-database";
import { createAgentRepository } from "../agents/agent-repository";
import { createKnowledgeRepository } from "./knowledge-repository";

describe("KnowledgeRepository", () => {
  const databases: Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it("删除知识库时在同一事务级联删除绑定和文档元数据", async () => {
    const database = createTestDatabase();
    databases.push(database);
    await createAgentRepository(database).insert({
      version: 1,
      id: "a1",
      name: "Agent",
      avatar: { kind: "initial", value: "A" },
      description: "",
      status: "active",
      cwd: "/workspace/a1",
      allowedTools: [],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    const repository = createKnowledgeRepository(database);
    const base = await repository.createBase({ name: "手册", description: "说明" });
    await repository.replaceBindings(base.id, ["a1"]);
    await repository.insertDocument({
      id: "d1",
      knowledgeBaseId: base.id,
      name: "guide.md",
      mediaType: "text/markdown",
      status: "indexed",
      createdAt: "2026-08-07T00:00:00.000Z",
    });

    await repository.removeBase(base.id);

    expect(await repository.getBase(base.id)).toBeUndefined();
    expect(await repository.listBaseIdsForAgent("a1")).toEqual([]);
    expect(await repository.listDocuments(base.id)).toEqual([]);
  });

  it("替换绑定会去重并以单个事务提交", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const agents = createAgentRepository(database);
    for (const id of ["a1", "a2"]) {
      await agents.insert({
        version: 1, id, name: id, avatar: { kind: "initial", value: "A" }, description: "", status: "active",
        cwd: `/workspace/${id}`, allowedTools: [], createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
      });
    }
    const repository = createKnowledgeRepository(database);
    const base = await repository.createBase({ name: "手册" });

    await repository.replaceBindings(base.id, ["a2", "a1", "a2"]);

    expect(await repository.listBindings()).toEqual([
      { knowledgeBaseId: base.id, agentId: "a1" },
      { knowledgeBaseId: base.id, agentId: "a2" },
    ]);
  });

  it("批量资料元数据任一写入失败时回滚整个批次", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const repository = createKnowledgeRepository(database);
    const base = await repository.createBase({ name: "批量资料" });
    const document = {
      id: "duplicate",
      knowledgeBaseId: base.id,
      name: "a.txt",
      mediaType: "text/plain",
      status: "indexed" as const,
      createdAt: "2026-08-07T00:00:00.000Z",
    };

    await expect(repository.insertDocuments([document, { ...document, name: "b.txt" }])).rejects.toThrow();

    expect(await repository.listDocuments(base.id)).toEqual([]);
  });
});
