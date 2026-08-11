// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  createGetKnowledgeDocumentTool,
  createManageKnowledgeBaseTool,
  createSearchKnowledgeTool,
} from "./knowledge-tools";

describe("知识库 Pi 工具", () => {
  it("检索工具始终以当前 Agent 的授权范围查询", async () => {
    const calls: unknown[] = [];
    const tool = createSearchKnowledgeTool("agent-a", {
      searchForAgent: async (agentId, input) => {
        calls.push({ agentId, input });
        return {
          data: {
            query: input.query,
            searchedKnowledgeBases: [{ id: "base-1", name: "资料库" }],
            results: [{
              rank: 1,
              knowledgeBase: { id: "base-1", name: "资料库" },
              document: { id: "doc-1", name: "手册.md", mediaType: "text/markdown" },
              chunk: { id: "chunk-1", index: 0, page: 1, section: null, text: "命中内容" },
              matchedBy: ["full_text" as const],
            }],
          },
          metadata: { resultCount: 1, retrievalMode: "full_text" as const, truncated: false },
          warnings: [],
        };
      },
    });
    const result = await tool.execute("call", { query: "命中", knowledgeBaseId: "base-1", limit: 3 }, undefined, undefined, {} as never);
    expect(calls).toEqual([{ agentId: "agent-a", input: { query: "命中", knowledgeBaseIds: ["base-1"], limit: 3 } }]);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("doc-1") });
  });

  it("单文件详情工具不允许指定其他 Agent", async () => {
    const tool = createGetKnowledgeDocumentTool("agent-a", {
      getDocumentForAgent: async (agentId, documentId) => ({ id: documentId, knowledgeBaseId: "base-1", name: "手册.txt", mediaType: "text/plain", status: "indexed", createdAt: "2026-08-07T00:00:00.000Z", text: agentId }),
    });
    const result = await tool.execute("call", { documentId: "doc-1" }, undefined, undefined, {} as never);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("agent-a") });
  });

  it("合并管理工具按 action 限制当前 Agent 的知识库和工作区范围", async () => {
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
        calls.push({ type: "modify", agentId, knowledgeBaseId, input });
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
    const tool = createManageKnowledgeBaseTool("agent-a", service, files);

    const listed = await tool.execute("call", { action: "list" }, undefined, undefined, {} as never);
    const created = await tool.execute("call", { action: "create", name: "新资料", description: "说明" }, undefined, undefined, {} as never);
    const modified = await tool.execute("call", { action: "modify_knowladge_base", knowledgeBaseId: "base-a", name: "新名称" }, undefined, undefined, {} as never);
    const uploaded = await tool.execute("call", { action: "upload_documents", knowledgeBaseId: "base-a", paths: ["docs/manual.md"] }, undefined, undefined, {} as never);
    const deletedBase = await tool.execute("call", { action: "delete_base", knowledgeBaseId: "base-a" }, undefined, undefined, {} as never);
    const deletedDocument = await tool.execute("call", { action: "delete_document", knowledgeBaseId: "base-a", documentId: "document-a" }, undefined, undefined, {} as never);

    expect(calls).toEqual([
      { type: "list", agentId: "agent-a" },
      { type: "create", agentId: "agent-a", input: { name: "新资料", description: "说明" } },
      { type: "modify", agentId: "agent-a", knowledgeBaseId: "base-a", input: { name: "新名称" } },
      { type: "read-file", agentId: "agent-a", path: "docs/manual.md" },
      { type: "upload", agentId: "agent-a", knowledgeBaseId: "base-a", names: ["manual.md"] },
      { type: "delete-base", agentId: "agent-a", knowledgeBaseId: "base-a" },
      { type: "delete-document", agentId: "agent-a", knowledgeBaseId: "base-a", documentId: "document-a" },
    ]);
    expect(tool.name).toBe("manage_knowledge_base");
    expect(listed.content[0]).toMatchObject({ text: expect.stringContaining("documentCount") });
    expect(created.content[0]).toMatchObject({ text: expect.stringContaining("新资料") });
    expect(modified.content[0]).toMatchObject({ text: expect.stringContaining("新名称") });
    expect(uploaded.content[0]).toMatchObject({ text: expect.stringContaining("manual.md") });
    expect(deletedBase.content[0]).toMatchObject({ text: expect.stringContaining("deleted") });
    expect(deletedDocument.content[0]).toMatchObject({ text: expect.stringContaining("document-a") });
  });

  it("合并管理工具拒绝缺失 action 必填字段", async () => {
    const tool = createManageKnowledgeBaseTool("agent-a", {} as never, {} as never);

    const result = await tool.execute("call", { action: "upload_documents", knowledgeBaseId: "base-b", paths: [] }, undefined, undefined, {} as never);

    expect(result.content[0]).toMatchObject({ type: "text", text: "至少提供一份工作区资料" });
  });
});
