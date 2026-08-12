// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "@lancedb/lancedb";

import { createKnowledgeLanceIndex } from "./lance-index";

describe("KnowledgeLanceIndex", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("重开本地 LanceDB 后仍能以中文关键词检索并按资料删除切片", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-lance-"));
    roots.push(root);
    const index = createKnowledgeLanceIndex(root);
    await index.upsertChunks("base-a", [
      { chunkId: "chunk-1", documentId: "document-a", index: 0, text: "年假需要提前提交申请", page: 1 },
      { chunkId: "chunk-2", documentId: "document-b", index: 0, text: "报销必须保留原始发票", page: 2 },
    ]);

    expect(await index.search("base-a", "提前申请", 5)).toEqual([
      expect.objectContaining({ chunkId: "chunk-1", documentId: "document-a", page: 1 }),
    ]);

    const reopened = createKnowledgeLanceIndex(root);
    expect(await reopened.search("base-a", "原始发票", 5)).toEqual([
      expect.objectContaining({ chunkId: "chunk-2", documentId: "document-b", page: 2 }),
    ]);
    await reopened.removeDocument("base-a", "document-a");
    expect(await reopened.search("base-a", "年假", 5)).toEqual([]);
  });

  it("按资料读取分片时保留原始顺序，删除后不再返回", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-lance-"));
    roots.push(root);
    const index = createKnowledgeLanceIndex(root);
    await index.upsertChunks("base-a", [
      { chunkId: "chunk-2", documentId: "document-a", index: 1, text: "第二段", page: 2, section: "审批" },
      { chunkId: "chunk-1", documentId: "document-a", index: 0, text: "第一段", page: 1, section: null },
      { chunkId: "chunk-other", documentId: "document-b", index: 0, text: "其他资料", page: 1 },
    ]);

    await expect(index.listDocumentChunks!("base-a", "document-a")).resolves.toEqual([
      { chunkId: "chunk-1", documentId: "document-a", index: 0, text: "第一段", page: 1, section: null },
      { chunkId: "chunk-2", documentId: "document-a", index: 1, text: "第二段", page: 2, section: "审批" },
    ]);

    await index.removeDocument("base-a", "document-a");
    await expect(index.listDocumentChunks!("base-a", "document-a")).resolves.toEqual([]);
  });

  it("保存向量后按余弦距离返回最接近的资料切片", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-vector-"));
    roots.push(root);
    const index = createKnowledgeLanceIndex(root);
    await index.upsertVectorChunks!("base-a", [
      { chunkId: "chunk-1", documentId: "document-a", index: 0, text: "年假申请", vector: [1, 0] },
      { chunkId: "chunk-2", documentId: "document-b", index: 0, text: "报销发票", vector: [0, 1] },
    ]);

    expect(await index.searchVectors!("base-a", [0.9, 0.1], 1)).toEqual([
      expect.objectContaining({ chunkId: "chunk-1", documentId: "document-a" }),
    ]);
  });

  it("为存量索引补充章节列后继续写入", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-legacy-lance-"));
    roots.push(root);
    const connection = await connect(join(root, "base-a"));
    await connection.createTable("chunks", [{
      chunkId: "legacy",
      documentId: "document-a",
      index: 0,
      text: "旧切片",
      page: 1,
    }]);
    const index = createKnowledgeLanceIndex(root);

    await index.upsertChunks("base-a", [{
      chunkId: "new",
      documentId: "document-a",
      index: 1,
      text: "新切片",
      page: 2,
      section: "新章节",
    }]);

    await expect(index.listDocumentChunks!("base-a", "document-a")).resolves.toEqual([
      { chunkId: "legacy", documentId: "document-a", index: 0, text: "旧切片", page: 1, section: null },
      { chunkId: "new", documentId: "document-a", index: 1, text: "新切片", page: 2, section: "新章节" },
    ]);
  });
});
