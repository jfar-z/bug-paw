// @vitest-environment node

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDataPaths } from "../paths";
import type { Database } from "../database/database";
import { createTestDatabase } from "../database/test-database";
import { createAgentRepository } from "../agents/agent-repository";
import { createKnowledgeRepository } from "./knowledge-repository";
import { createKnowledgeBaseService } from "./knowledge-base-service";
import type { KnowledgeIndexChunk, KnowledgeIndexSearchResult } from "./lance-index";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("KnowledgeBaseService", () => {
  const roots: string[] = [];
  const databases: Database[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    databases.splice(0).forEach((database) => database.close());
  });

  it("仅允许绑定 Agent 检索和查看已索引资料", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async (agentId) => agentId === "agent-a" || agentId === "agent-b",
    });
    const base = await service.createBase({ name: "员工手册", agentIds: ["agent-a"] });
    const [document] = await service.uploadDocuments(base.id, [{
      name: "请假.txt",
      mediaType: "text/plain",
      content: Buffer.from("年假需要提前提交申请", "utf8"),
    }]);

    await expect(service.searchForAgent("agent-a", { query: "提前申请" })).resolves.toMatchObject({
      data: { results: [expect.objectContaining({ document: expect.objectContaining({ id: document.id }) })] },
      metadata: { resultCount: 1, retrievalMode: "full_text" },
    });
    await expect(service.getDocumentForAgent("agent-a", document.id)).resolves.toMatchObject({ id: document.id, status: "indexed" });
    await expect(service.getDocumentForAgent("agent-b", document.id)).rejects.toThrow("无权访问");
  });

  it("供管理端查看、更新绑定、检索和删除资料", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async (agentId) => agentId === "agent-a" || agentId === "agent-b",
    });
    const base = await service.createBase({ name: "产品资料", agentIds: ["agent-a"] });
    const [document] = await service.uploadDocuments(base.id, [{
      name: "产品.txt",
      mediaType: "text/plain",
      content: Buffer.from("知识库支持关键词检索", "utf8"),
    }]);

    await expect(service.listBases()).resolves.toEqual([
      expect.objectContaining({ id: base.id, agentIds: ["agent-a"], documents: [expect.objectContaining({ id: document.id })] }),
    ]);
    await expect(service.searchBase(base.id, "关键词")).resolves.toEqual([
      expect.objectContaining({ documentId: document.id }),
    ]);
    await expect(service.updateBase(base.id, { name: "产品知识库", agentIds: ["agent-b"] })).resolves.toMatchObject({
      name: "产品知识库",
      agentIds: ["agent-b"],
    });
    await expect(service.removeDocument(base.id, document.id)).resolves.toBeUndefined();
    await expect(service.getDocument(base.id, document.id)).resolves.toBeUndefined();
  });

  it("语义索引将资料作为文档编码，并将管理端和 Agent 查询作为查询编码", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const embedDocuments = vi.fn(async (input: string[]) => input.map(() => [0.1, 0.2]));
    const embedQuery = vi.fn(async () => [0.1, 0.2]);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async (agentId) => agentId === "agent-a",
      embeddingClient: { embedDocuments, embedQuery },
      index: {
        upsertChunks: vi.fn(async () => undefined),
        upsertVectorChunks: vi.fn(async () => undefined),
        search: vi.fn(async () => []),
        searchVectors: vi.fn(async () => []),
        removeDocument: vi.fn(async () => undefined),
      },
    });
    const base = await service.createBase({ name: "报销制度", agentIds: ["agent-a"] });
    await service.uploadDocuments(base.id, [{ name: "报销.txt", mediaType: "text/plain", content: Buffer.from("报销需提交发票", "utf8") }]);

    await expect(service.rebuildSemanticIndex()).resolves.toMatchObject({ rebuiltBases: 1, failedBases: [] });
    await service.searchBase(base.id, "发票要求");
    await service.searchForAgent("agent-a", { query: "报销流程" });

    expect(embedDocuments).toHaveBeenCalledWith(["报销需提交发票"]);
    expect(embedQuery).toHaveBeenNthCalledWith(1, "发票要求");
    expect(embedQuery).toHaveBeenNthCalledWith(2, "报销流程");
  });

  it("启用语义检索时上传资料同步建立全文和向量索引", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const embedDocuments = vi.fn(async (input: string[]) => input.map(() => [0.1, 0.2]));
    const upsertChunks = vi.fn(async () => undefined);
    const upsertVectorChunks = vi.fn(async () => undefined);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async () => true,
      embeddingClient: { embedDocuments, embedQuery: vi.fn(async () => [0.1, 0.2]) },
      isSemanticSearchEnabled: async () => true,
      index: {
        upsertChunks,
        upsertVectorChunks,
        search: vi.fn(async () => []),
        removeDocument: vi.fn(async () => undefined),
      },
    });
    const base = await service.createBase({ name: "自动索引" });

    await service.uploadDocuments(base.id, [{ name: "资料.txt", mediaType: "text/plain", content: Buffer.from("上传时建立语义索引", "utf8") }]);

    expect(embedDocuments).toHaveBeenCalledWith(["上传时建立语义索引"]);
    expect(upsertChunks).toHaveBeenCalledOnce();
    expect(upsertVectorChunks).toHaveBeenCalledOnce();
  });

  it("禁用语义检索时上传资料只建立全文索引", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const embedDocuments = vi.fn(async (input: string[]) => input.map(() => [0.1, 0.2]));
    const upsertChunks = vi.fn(async () => undefined);
    const upsertVectorChunks = vi.fn(async () => undefined);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async () => true,
      embeddingClient: { embedDocuments, embedQuery: vi.fn(async () => [0.1, 0.2]) },
      isSemanticSearchEnabled: async () => false,
      index: {
        upsertChunks,
        upsertVectorChunks,
        search: vi.fn(async () => []),
        removeDocument: vi.fn(async () => undefined),
      },
    });
    const base = await service.createBase({ name: "仅全文" });

    await service.uploadDocuments(base.id, [{ name: "资料.txt", mediaType: "text/plain", content: Buffer.from("关闭语义检索", "utf8") }]);

    expect(upsertChunks).toHaveBeenCalledOnce();
    expect(embedDocuments).not.toHaveBeenCalled();
    expect(upsertVectorChunks).not.toHaveBeenCalled();
  });

  it("禁用语义检索时查询直接使用全文索引", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const embedQuery = vi.fn(async () => [0.1, 0.2]);
    const search = vi.fn(async (_knowledgeBaseId: string, _query: string, _limit: number): Promise<KnowledgeIndexSearchResult[]> => []);
    const searchVectors = vi.fn(async () => []);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async () => true,
      embeddingClient: { embedDocuments: vi.fn(async () => [[0.1, 0.2]]), embedQuery },
      isSemanticSearchEnabled: async () => false,
      index: {
        upsertChunks: vi.fn(async () => undefined),
        upsertVectorChunks: vi.fn(async () => undefined),
        search,
        searchVectors,
        removeDocument: vi.fn(async () => undefined),
      },
    });
    const base = await service.createBase({ name: "查询回退" });
    const [document] = await service.uploadDocuments(base.id, [{ name: "资料.txt", mediaType: "text/plain", content: Buffer.from("全文检索资料", "utf8") }]);
    search.mockResolvedValueOnce([{ chunkId: `${document.id}:0`, documentId: document.id, index: 0, text: "全文检索资料" }]);

    await expect(service.searchBase(base.id, "全文检索")).resolves.toEqual([expect.objectContaining({ documentId: document.id })]);

    expect(embedQuery).not.toHaveBeenCalled();
    expect(searchVectors).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(base.id, "全文检索", 10);
  });

  it("跨知识库融合全文与向量结果并在最终阶段统一截断", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const store = await createStore();
    const search = vi.fn<(baseId: string, query: string, limit: number) => Promise<KnowledgeIndexSearchResult[]>>(async () => []);
    const searchVectors = vi.fn<(baseId: string, vector: number[], limit: number) => Promise<KnowledgeIndexSearchResult[]>>(async () => []);
    const embedQuery = vi.fn(async () => [0.1, 0.2]);
    const service = createKnowledgeBaseService({
      paths,
      store,
      agentExists: async () => true,
      embeddingClient: { embedDocuments: vi.fn(async (values: string[]) => values.map(() => [0.1, 0.2])), embedQuery },
      isSemanticSearchEnabled: async () => true,
      index: {
        upsertChunks: vi.fn(async () => undefined),
        upsertVectorChunks: vi.fn(async () => undefined),
        search,
        searchVectors,
        removeDocument: vi.fn(async () => undefined),
      },
    });
    const baseA = await service.createBase({ name: "A 库", agentIds: ["agent-a"] });
    const baseB = await service.createBase({ name: "B 库", agentIds: ["agent-a"] });
    const [documentA] = await service.uploadDocuments(baseA.id, [{ name: "A.md", mediaType: "text/markdown", content: Buffer.from("A 部署要求") }]);
    const [documentB] = await service.uploadDocuments(baseB.id, [{ name: "B.md", mediaType: "text/markdown", content: Buffer.from("B 部署要求") }]);
    const resultForBase = (baseId: string): KnowledgeIndexSearchResult[] => [{
      chunkId: `${baseId === baseA.id ? documentA.id : documentB.id}:0`,
      documentId: baseId === baseA.id ? documentA.id : documentB.id,
      index: 0,
      text: baseId === baseA.id ? "A 部署要求" : "B 部署要求",
      page: 1,
      section: null,
    }];
    search.mockImplementation(async (baseId) => resultForBase(baseId));
    searchVectors.mockImplementation(async (baseId) => resultForBase(baseId));

    const result = await service.searchForAgent("agent-a", {
      query: "部署要求",
      knowledgeBaseIds: [baseA.id, baseB.id],
      limit: 3,
    });

    expect(result.data.searchedKnowledgeBases).toEqual([
      { id: baseA.id, name: "A 库" },
      { id: baseB.id, name: "B 库" },
    ]);
    expect(result.metadata).toMatchObject({ resultCount: 2, retrievalMode: "hybrid" });
    expect(result.data.results.map((item) => item.knowledgeBase.id)).toEqual(expect.arrayContaining([baseA.id, baseB.id]));
    expect(result.data.results.map((item) => item.rank)).toEqual([1, 2]);
    expect(result.data.results[0]).toMatchObject({
      document: { id: expect.any(String), name: expect.any(String) },
      chunk: { id: expect.any(String), page: 1, section: null },
      matchedBy: expect.arrayContaining(["full_text", "vector"]),
    });
    expect(embedQuery).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledTimes(2);
    expect(searchVectors).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.every((call) => call[2] === 20)).toBe(true);
  });

  it("向量查询失败时保留全文结果并返回降级警告", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const store = await createStore();
    const search = vi.fn(async (): Promise<KnowledgeIndexSearchResult[]> => []);
    const service = createKnowledgeBaseService({
      paths,
      store,
      agentExists: async () => true,
      embeddingClient: {
        embedDocuments: vi.fn(async (values: string[]) => values.map(() => [0.1, 0.2])),
        embedQuery: vi.fn(async () => { throw new Error("vector unavailable"); }),
      },
      isSemanticSearchEnabled: async () => true,
      index: {
        upsertChunks: vi.fn(async () => undefined),
        upsertVectorChunks: vi.fn(async () => undefined),
        search,
        searchVectors: vi.fn(async () => []),
        removeDocument: vi.fn(async () => undefined),
      },
    });
    const base = await service.createBase({ name: "制度库", agentIds: ["agent-a"] });
    const [document] = await service.uploadDocuments(base.id, [{ name: "制度.md", mediaType: "text/markdown", content: Buffer.from("部署制度") }]);
    search.mockResolvedValueOnce([{ chunkId: `${document.id}:0`, documentId: document.id, index: 0, text: "部署制度", page: 1 }]);

    const result = await service.searchForAgent("agent-a", { query: "部署" });

    expect(result.metadata).toMatchObject({ resultCount: 1, retrievalMode: "full_text" });
    expect(result.data.results).toHaveLength(1);
    expect(result.warnings).toEqual([{ code: "VECTOR_SEARCH_UNAVAILABLE", message: "语义检索暂时不可用，结果仅来自全文检索" }]);
  });

  it("按命中切片读取相邻上下文并支持整篇分页读取", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const listDocumentChunks = vi.fn(async () => [] as KnowledgeIndexChunk[]);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async () => true,
      index: {
        upsertChunks: vi.fn(async () => undefined),
        listDocumentChunks,
        search: vi.fn(async () => []),
        removeDocument: vi.fn(async () => undefined),
      },
    });
    const base = await service.createBase({ name: "上下文库", agentIds: ["agent-a"] });
    const text = "0123456789abcdefghijABCDEFGHIJ";
    const [document] = await service.uploadDocuments(base.id, [{ name: "上下文.txt", mediaType: "text/plain", content: Buffer.from(text) }]);
    listDocumentChunks.mockResolvedValue([
      { chunkId: `${document.id}:0`, documentId: document.id, index: 0, text: "第一段", page: 1, section: null },
      { chunkId: `${document.id}:1`, documentId: document.id, index: 1, text: "第二段", page: 2, section: null },
      { chunkId: `${document.id}:2`, documentId: document.id, index: 2, text: "第三段", page: 2, section: "审批" },
      { chunkId: `${document.id}:3`, documentId: document.id, index: 3, text: "第四段", page: 3, section: null },
    ]);

    const around = await service.readForAgent("agent-a", {
      mode: "around_chunk",
      documentId: document.id,
      anchorChunkId: `${document.id}:2`,
      beforeChunks: 1,
      afterChunks: 1,
      maxCharacters: 12_000,
    });
    expect(around.data.location).toMatchObject({ startChunkIndex: 1, endChunkIndex: 3, startPage: 2, endPage: 3 });
    expect(around.data.content).toContain("第二段\n\n第三段\n\n第四段");

    const page = await service.readForAgent("agent-a", {
      mode: "document",
      documentId: document.id,
      offset: 10,
      maxCharacters: 20,
    });
    expect(page.data.content).toBe("abcdefghijABCDEFGHIJ");
    expect(page.metadata).toMatchObject({ offset: 10, contentCharacters: 30, returnedCharacters: 20, truncated: false });

    await expect(service.readForAgent("agent-a", {
      mode: "around_chunk",
      documentId: document.id,
      anchorChunkId: "another-document:2",
    })).rejects.toThrow("命中切片不属于指定资料");
  });

  it("上传时生成向量失败会清理索引并标记资料失败", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const removeDocument = vi.fn(async () => undefined);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async () => true,
      embeddingClient: {
        embedDocuments: vi.fn(async () => { throw new Error("embedding unavailable"); }),
        embedQuery: vi.fn(async () => [0.1, 0.2]),
      },
      isSemanticSearchEnabled: async () => true,
      index: {
        upsertChunks: vi.fn(async () => undefined),
        upsertVectorChunks: vi.fn(async () => undefined),
        search: vi.fn(async () => []),
        removeDocument,
      },
    });
    const base = await service.createBase({ name: "索引回滚" });

    const [document] = await service.uploadDocuments(base.id, [{ name: "资料.txt", mediaType: "text/plain", content: Buffer.from("向量失败", "utf8") }]);

    expect(document).toMatchObject({ status: "failed" });
    expect(removeDocument).toHaveBeenCalledWith(base.id, document.id);
  });

  it("删除知识库时清理其资料与 Agent 绑定", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async (agentId) => agentId === "agent-a",
    });
    const base = await service.createBase({ name: "待删除", agentIds: ["agent-a"] });
    await service.uploadDocuments(base.id, [{ name: "资料.md", mediaType: "text/markdown", content: Buffer.from("# 删除验证", "utf8") }]);

    await expect(service.removeBase(base.id)).resolves.toBe(true);
    await expect(service.getBase(base.id)).resolves.toBeUndefined();
    await expect(service.searchForAgent("agent-a", { query: "删除验证" })).rejects.toThrow("没有可访问的知识库");
  });

  it("Agent 只能管理自己已绑定的知识库", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async (agentId) => agentId === "agent-a" || agentId === "agent-b",
    });
    const baseA = await service.createBase({ name: "A 的资料", agentIds: ["agent-a"] });
    const baseB = await service.createBase({ name: "B 的资料", agentIds: ["agent-b"] });

    await expect(service.listBasesForAgent("agent-a")).resolves.toEqual([
      expect.objectContaining({ id: baseA.id, name: "A 的资料", documentCount: 0 }),
    ]);
    await expect(service.createBaseForAgent("agent-a", { name: "新资料" })).resolves.toMatchObject({
      name: "新资料",
      documentCount: 0,
    });
    await expect(service.removeBaseForAgent("agent-b", baseA.id)).rejects.toThrow("无权管理该知识库");
    await expect(service.removeBaseForAgent("agent-a", baseA.id)).resolves.toBeUndefined();
    await expect(service.getBase(baseA.id)).resolves.toBeUndefined();
    await expect(service.getBase(baseB.id)).resolves.toMatchObject({ id: baseB.id });
  });

  it("Agent 可维护已绑定知识库的资料，但不能越权操作或读取完整 Agent 正文", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async (agentId) => agentId === "agent-a" || agentId === "agent-b",
    });
    const base = await service.createBase({ name: "员工资料", agentIds: ["agent-a"] });
    const [document] = await service.uploadDocuments(base.id, [{
      name: "手册.md",
      mediaType: "text/markdown",
      content: Buffer.from(`# 原始手册\n\n${"知识库正文。".repeat(3_000)}`, "utf8"),
    }]);

    await expect(service.updateBaseForAgent("agent-a", base.id, { name: "员工知识库", description: "供内部查询" }))
      .resolves.toMatchObject({ name: "员工知识库", description: "供内部查询" });
    await expect(service.uploadDocumentsForAgent("agent-b", base.id, [{
      name: "越权.txt", mediaType: "text/plain", content: Buffer.from("不应写入", "utf8"),
    }])).rejects.toThrow("无权管理该知识库");
    await expect(service.getDocumentSource(base.id, document.id)).resolves.toMatchObject({
      name: "手册.md",
      mediaType: "text/markdown",
      path: expect.stringContaining("/source"),
      size: expect.any(Number),
    });
    await expect(service.getDocumentForAgent("agent-a", document.id)).resolves.toMatchObject({ textTruncated: true });
    await expect(service.getDocument(base.id, document.id)).resolves.toMatchObject({ textTruncated: false });
    await expect(service.removeDocumentForAgent("agent-a", base.id, document.id)).resolves.toBeUndefined();
    await expect(service.getDocument(base.id, document.id)).resolves.toBeUndefined();
  });

  it("同一上传批次逐文档释放正文和切片后再更新索引", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const upsertChunks = vi.fn(async (_knowledgeBaseId: string, _chunks: KnowledgeIndexChunk[]) => undefined);
    const service = createKnowledgeBaseService({
      paths,
      store: await createStore(),
      agentExists: async () => true,
      index: {
        upsertChunks,
        search: vi.fn(async () => []),
        removeDocument: vi.fn(async () => undefined),
      },
    });
    const base = await service.createBase({ name: "批量资料" });

    await service.uploadDocuments(base.id, [
      { name: "a.txt", mediaType: "text/plain", content: Buffer.from("第一份资料", "utf8") },
      { name: "b.txt", mediaType: "text/plain", content: Buffer.from("第二份资料", "utf8") },
    ]);

    expect(upsertChunks).toHaveBeenCalledTimes(2);
    expect(upsertChunks.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ index: 0, text: "第一份资料" }),
    ]);
    expect(upsertChunks.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ index: 0, text: "第二份资料" }),
    ]);
  });

  it("同一知识库的上传与删除严格串行，避免跨存储竞态", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const store = await createStore();
    const indexing = deferred<void>();
    const removeBase = vi.spyOn(store, "removeBase");
    const upsertChunks = vi.fn(() => indexing.promise);
    const service = createKnowledgeBaseService({
      paths,
      store,
      agentExists: async () => true,
      index: {
        upsertChunks,
        search: vi.fn(async () => []),
        removeDocument: vi.fn(async () => undefined),
      },
    });
    const base = await service.createBase({ name: "并发保护" });
    const uploading = service.uploadDocuments(base.id, [{ name: "a.txt", mediaType: "text/plain", content: Buffer.from("正文") }]);
    await vi.waitFor(() => expect(upsertChunks).toHaveBeenCalledOnce());
    const removing = service.removeBase(base.id);

    await Promise.resolve();
    expect(removeBase).not.toHaveBeenCalled();
    indexing.resolve();
    await uploading;
    await expect(removing).resolves.toBe(true);
    expect(removeBase).toHaveBeenCalledOnce();
  });

  it("资料元数据批量提交失败时删除已写源文件并补偿索引", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const store = await createStore();
    const removeDocument = vi.fn(async () => undefined);
    const service = createKnowledgeBaseService({
      paths,
      store,
      agentExists: async () => true,
      index: { upsertChunks: vi.fn(async () => undefined), search: vi.fn(async () => []), removeDocument },
    });
    const base = await service.createBase({ name: "批量补偿" });
    vi.spyOn(store, "insertDocuments").mockRejectedValueOnce(new Error("database failed"));

    await expect(service.uploadDocuments(base.id, [{ name: "a.txt", mediaType: "text/plain", content: Buffer.from("正文") }])).rejects.toThrow("database failed");

    await expect(readdir(join(paths.knowledgeDir, "sources", base.id))).resolves.toEqual([]);
    expect(removeDocument).toHaveBeenCalledOnce();
  });

  it("删除知识库元数据失败时恢复已暂存的源文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const store = await createStore();
    const service = createKnowledgeBaseService({ paths, store, agentExists: async () => true });
    const base = await service.createBase({ name: "删除补偿" });
    const [document] = await service.uploadDocuments(base.id, [{ name: "a.txt", mediaType: "text/plain", content: Buffer.from("正文") }]);
    vi.spyOn(store, "removeBase").mockRejectedValueOnce(new Error("database failed"));

    await expect(service.removeBase(base.id)).rejects.toThrow("database failed");

    await expect(service.getDocumentSource(base.id, document.id)).resolves.toMatchObject({ name: "a.txt" });
  });

  it("删除资料元数据失败时恢复源文件和全文索引", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-service-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const store = await createStore();
    const upsertChunks = vi.fn(async () => undefined);
    const removeIndexDocument = vi.fn(async () => undefined);
    const service = createKnowledgeBaseService({
      paths,
      store,
      agentExists: async () => true,
      index: { upsertChunks, search: vi.fn(async () => []), removeDocument: removeIndexDocument },
    });
    const base = await service.createBase({ name: "资料删除补偿" });
    const [document] = await service.uploadDocuments(base.id, [{ name: "a.txt", mediaType: "text/plain", content: Buffer.from("可恢复正文") }]);
    vi.spyOn(store, "removeDocument").mockRejectedValueOnce(new Error("database failed"));

    await expect(service.removeDocument(base.id, document.id)).rejects.toThrow("database failed");

    await expect(service.getDocumentSource(base.id, document.id)).resolves.toMatchObject({ name: "a.txt" });
    expect(removeIndexDocument).toHaveBeenCalledWith(base.id, document.id);
    expect(upsertChunks).toHaveBeenLastCalledWith(base.id, [expect.objectContaining({ documentId: document.id, text: "可恢复正文" })]);
  });

  async function createStore() {
    const database = createTestDatabase();
    databases.push(database);
    const agents = createAgentRepository(database);
    for (const id of ["agent-a", "agent-b"]) {
      await agents.insert({
        version: 1, id, name: id, avatar: { kind: "initial", value: "A" }, description: "", status: "active",
        cwd: `/workspace/${id}`, allowedTools: [], createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
      });
    }
    return createKnowledgeRepository(database);
  }
});
