// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createKnowledgeManageTool,
  createKnowledgeReadTool,
  createKnowledgeSearchTool,
} from "./knowledge-tools";

const searchData = {
  query: "部署",
  searchedKnowledgeBases: [{ id: "base-1", name: "资料库" }],
  results: [{
    rank: 1,
    knowledgeBase: { id: "base-1", name: "资料库" },
    document: { id: "doc-1", name: "手册.md", mediaType: "text/markdown" },
    chunk: { id: "doc-1:0", index: 0, page: 1, section: null, text: "部署证据" },
    matchedBy: ["full_text" as const, "vector" as const],
  }],
};

function parseResult(result: { content: readonly unknown[] }) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

/** 断言工具参数使用 Provider 兼容的根对象 Schema。 */
function expectObjectRootSchema(tool: { parameters: unknown }): void {
  const schema = tool.parameters as Record<string, unknown>;
  expect(schema.type).toBe("object");
  expect(schema).not.toHaveProperty("anyOf");
  expect(schema).not.toHaveProperty("oneOf");
  expect(schema).not.toHaveProperty("allOf");
}

describe("知识库 Pi 工具", () => {
  it("所有知识库工具都使用无根组合关键字的 Object Schema", () => {
    const service = {} as never;
    const files = {} as never;

    expectObjectRootSchema(createKnowledgeSearchTool("agent-a", service));
    expectObjectRootSchema(createKnowledgeReadTool("agent-a", service));
    expectObjectRootSchema(createKnowledgeManageTool("agent-a", service, files));
  });

  it("knowledge_search 转发多个知识库范围并返回统一成功协议", async () => {
    const calls: unknown[] = [];
    const tool = createKnowledgeSearchTool("agent-a", {
      searchForAgent: async (agentId, input) => {
        calls.push({ agentId, input });
        return {
          data: searchData,
          metadata: { resultCount: 1, retrievalMode: "hybrid", truncated: false },
          warnings: [],
        };
      },
    });

    const result = await tool.execute("call", {
      query: "部署",
      knowledgeBaseIds: ["base-1", "base-2"],
      limit: 3,
    }, undefined, undefined, {} as never);
    const parsed = parseResult(result);

    expect(tool.name).toBe("knowledge_search");
    expect(calls).toEqual([{
      agentId: "agent-a",
      input: { query: "部署", knowledgeBaseIds: ["base-1", "base-2"], limit: 3 },
    }]);
    expect(parsed).toMatchObject({
      status: "ok",
      data: { results: [{ document: { name: "手册.md" }, chunk: { id: "doc-1:0" } }] },
      metadata: { resultCount: 1, retrievalMode: "hybrid" },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/nextAction|suggestedAction|recommendation/u);
  });

  it("knowledge_search 区分空结果和向量降级", async () => {
    const emptyTool = createKnowledgeSearchTool("agent-a", {
      searchForAgent: async () => ({
        data: { ...searchData, results: [] },
        metadata: { resultCount: 0, retrievalMode: "full_text", truncated: false },
        warnings: [],
      }),
    });
    const partialTool = createKnowledgeSearchTool("agent-a", {
      searchForAgent: async () => ({
        data: searchData,
        metadata: { resultCount: 1, retrievalMode: "full_text", truncated: false },
        warnings: [{ code: "VECTOR_SEARCH_UNAVAILABLE", message: "语义检索暂时不可用" }],
      }),
    });

    const empty = await emptyTool.execute("empty", { query: "无命中" }, undefined, undefined, {} as never);
    const partial = await partialTool.execute("partial", { query: "部署" }, undefined, undefined, {} as never);

    expect(parseResult(empty)).toMatchObject({ status: "empty", metadata: { resultCount: 0 } });
    expect(parseResult(partial)).toMatchObject({
      status: "partial",
      warnings: [{ code: "VECTOR_SEARCH_UNAVAILABLE" }],
    });
  });

  it("knowledge_read 按严格联合参数读取命中上下文和整篇分页", async () => {
    const calls: unknown[] = [];
    const tool = createKnowledgeReadTool("agent-a", {
      readForAgent: async (agentId, input) => {
        calls.push({ agentId, input });
        return {
          data: {
            mode: input.mode,
            knowledgeBase: { id: "base-1", name: "资料库" },
            document: { id: input.documentId, name: "手册.md", mediaType: "text/markdown" },
            content: "上下文",
            location: { startChunkIndex: 0, endChunkIndex: 2, startPage: 1, endPage: 2 },
          },
          metadata: { offset: 0, contentCharacters: 3, returnedCharacters: 3, truncated: false },
          warnings: [],
        };
      },
    });

    const around = await tool.execute("around", {
      mode: "around_chunk",
      documentId: "doc-1",
      anchorChunkId: "doc-1:1",
      beforeChunks: 1,
      afterChunks: 1,
      maxCharacters: 4_000,
    }, undefined, undefined, {} as never);
    const document = await tool.execute("document", {
      mode: "document",
      documentId: "doc-1",
      offset: 100,
      maxCharacters: 2_000,
    }, undefined, undefined, {} as never);

    expect(tool.name).toBe("knowledge_read");
    expect(parseResult(around)).toMatchObject({ status: "ok", data: { mode: "around_chunk" } });
    expect(parseResult(document)).toMatchObject({ status: "ok", data: { mode: "document" } });
    expect(calls).toEqual([
      { agentId: "agent-a", input: { mode: "around_chunk", documentId: "doc-1", anchorChunkId: "doc-1:1", beforeChunks: 1, afterChunks: 1, maxCharacters: 4_000 } },
      { agentId: "agent-a", input: { mode: "document", documentId: "doc-1", offset: 100, maxCharacters: 2_000 } },
    ]);
  });

  it("knowledge_read 缺少条件字段时不调用服务", async () => {
    const readForAgent = vi.fn();
    const tool = createKnowledgeReadTool("agent-a", { readForAgent });

    const result = await tool.execute(
      "bad-read",
      { mode: "around_chunk", documentId: "doc-1" } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(readForAgent).not.toHaveBeenCalled();
    expect(parseResult(result)).toMatchObject({ status: "error" });
  });

  it("knowledge_manage 使用六种规范 action 并保持工作区读取边界", async () => {
    const calls: unknown[] = [];
    const service = {
      listBasesForAgent: async (agentId: string) => {
        calls.push({ type: "list", agentId });
        return [{ id: "base-a", name: "产品资料", description: "", documentCount: 2, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z" }];
      },
      createBaseForAgent: async (agentId: string, input: { name: string; description?: string }) => {
        calls.push({ type: "create", agentId, input });
        return { id: "base-b", name: input.name, description: input.description ?? "", documentCount: 0, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z" };
      },
      updateBaseForAgent: async (agentId: string, knowledgeBaseId: string, input: { name?: string; description?: string }) => {
        calls.push({ type: "update", agentId, knowledgeBaseId, input });
        return { id: knowledgeBaseId, name: input.name ?? "产品资料", description: input.description ?? "", documentCount: 2, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z" };
      },
      uploadDocumentsForAgent: async (agentId: string, knowledgeBaseId: string, uploads: Array<{ name: string }>) => {
        calls.push({ type: "upload", agentId, knowledgeBaseId, names: uploads.map((upload) => upload.name) });
        return uploads.map((upload, index) => ({ id: `document-${index}`, knowledgeBaseId, name: upload.name, mediaType: "text/markdown", status: "indexed" as const, createdAt: "2026-08-07T00:00:00.000Z" }));
      },
      removeBaseForAgent: async (agentId: string, knowledgeBaseId: string) => {
        calls.push({ type: "delete-base", agentId, knowledgeBaseId });
      },
      removeDocumentForAgent: async (agentId: string, knowledgeBaseId: string, documentId: string) => {
        calls.push({ type: "delete-document", agentId, knowledgeBaseId, documentId });
      },
    };
    const files = {
      readFile: async (agentId: string, path: string) => {
        calls.push({ type: "read-file", agentId, path });
        return { name: "manual.md", mediaType: "text/markdown", content: Buffer.from("# 手册", "utf8") };
      },
    };
    const tool = createKnowledgeManageTool("agent-a", service, files);

    const results = [];
    results.push(await tool.execute("list", { action: "list_bases" }, undefined, undefined, {} as never));
    results.push(await tool.execute("create", { action: "create_base", name: "新资料", description: "说明" }, undefined, undefined, {} as never));
    results.push(await tool.execute("update", { action: "update_base", knowledgeBaseId: "base-a", name: "新名称" }, undefined, undefined, {} as never));
    results.push(await tool.execute("upload", { action: "upload_documents", knowledgeBaseId: "base-a", paths: ["docs/manual.md"] }, undefined, undefined, {} as never));
    results.push(await tool.execute("delete-document", { action: "delete_document", knowledgeBaseId: "base-a", documentId: "document-a" }, undefined, undefined, {} as never));
    results.push(await tool.execute("delete-base", { action: "delete_base", knowledgeBaseId: "base-a" }, undefined, undefined, {} as never));

    expect(tool.name).toBe("knowledge_manage");
    expect(calls).toEqual([
      { type: "list", agentId: "agent-a" },
      { type: "create", agentId: "agent-a", input: { name: "新资料", description: "说明" } },
      { type: "update", agentId: "agent-a", knowledgeBaseId: "base-a", input: { name: "新名称" } },
      { type: "read-file", agentId: "agent-a", path: "docs/manual.md" },
      { type: "upload", agentId: "agent-a", knowledgeBaseId: "base-a", names: ["manual.md"] },
      { type: "delete-document", agentId: "agent-a", knowledgeBaseId: "base-a", documentId: "document-a" },
      { type: "delete-base", agentId: "agent-a", knowledgeBaseId: "base-a" },
    ]);
    expect(results.map((result) => parseResult(result).status)).toEqual([
      "ok", "ok", "ok", "ok", "ok", "ok",
    ]);
  });

  it("knowledge_manage 缺少 action 条件字段时不调用服务或文件读取", async () => {
    const service = {
      listBasesForAgent: vi.fn(),
      createBaseForAgent: vi.fn(),
      updateBaseForAgent: vi.fn(),
      uploadDocumentsForAgent: vi.fn(),
      removeBaseForAgent: vi.fn(),
      removeDocumentForAgent: vi.fn(),
    };
    const files = { readFile: vi.fn() };
    const tool = createKnowledgeManageTool("agent-a", service, files);

    const result = await tool.execute(
      "bad-manage",
      { action: "delete_document", knowledgeBaseId: "base-1" } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(Object.values(service).every((method) => method.mock.calls.length === 0)).toBe(true);
    expect(files.readFile).not.toHaveBeenCalled();
    expect(parseResult(result)).toMatchObject({ status: "error" });
  });

  it("工具错误只返回稳定错误事实", async () => {
    const tool = createKnowledgeSearchTool("agent-a", {
      searchForAgent: async () => { throw new Error("无权访问指定知识库"); },
    });

    const result = await tool.execute("error", { query: "部署" }, undefined, undefined, {} as never);

    expect(parseResult(result)).toEqual({
      status: "error",
      error: { code: "KNOWLEDGE_SEARCH_FAILED", message: "无权访问指定知识库", retryable: false },
    });
  });
});
