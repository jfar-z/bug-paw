import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { KnowledgeDocument, KnowledgeBaseSummary, KnowledgeUpload } from "./knowledge-base-service";
import type { KnowledgeIndexSearchResult } from "./lance-index";
import { SYSTEM_LIMITS } from "../core/limits";

interface KnowledgeSearchService {
  searchForAgent(agentId: string, input: { query: string; knowledgeBaseId?: string; limit?: number }): Promise<KnowledgeIndexSearchResult[]>;
}

interface KnowledgeDocumentService {
  getDocumentForAgent(agentId: string, documentId: string): Promise<KnowledgeDocument>;
}

interface KnowledgeBaseManagementService {
  listBasesForAgent(agentId: string): Promise<KnowledgeBaseSummary[]>;
  createBaseForAgent(agentId: string, input: { name: string; description?: string }): Promise<KnowledgeBaseSummary>;
  updateBaseForAgent(agentId: string, knowledgeBaseId: string, input: { name?: string; description?: string }): Promise<KnowledgeBaseSummary>;
  uploadDocumentsForAgent(agentId: string, knowledgeBaseId: string, uploads: KnowledgeUpload[]): Promise<KnowledgeDocument[]>;
  removeBaseForAgent(agentId: string, knowledgeBaseId: string): Promise<void>;
  removeDocumentForAgent(agentId: string, knowledgeBaseId: string, documentId: string): Promise<void>;
}

/** Agent 工作区内受安全边界保护的资料读取能力。 */
interface KnowledgeWorkspaceFileReader {
  readFile(agentId: string, path: string, maxBytes: number): Promise<KnowledgeUpload>;
}

const MAX_KNOWLEDGE_FILE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/**
 * 创建只检索当前 Agent 已绑定知识库的 Pi SDK 工具。
 *
 * @param agentId 当前 Pi Runtime 所属 Agent
 * @param service 知识库检索应用服务
 */
export function createSearchKnowledgeTool(agentId: string, service: KnowledgeSearchService) {
  return defineTool({
    name: "search_knowledge",
    label: "检索知识库",
    description: "按关键词检索当前 Agent 已绑定的知识库，并返回命中文本片段和资料 ID。",
    promptSnippet: "需要从已绑定知识库查找依据时，使用 search_knowledge。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      knowledgeBaseId: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      try {
        return success(await service.searchForAgent(agentId, params));
      } catch (error) {
        return failure(error instanceof Error ? error.message : "知识库检索失败");
      }
    },
  });
}

/**
 * 创建只读取当前 Agent 可访问单份资料的 Pi SDK 工具。
 *
 * @param agentId 当前 Pi Runtime 所属 Agent
 * @param service 知识库资料应用服务
 */
export function createGetKnowledgeDocumentTool(agentId: string, service: KnowledgeDocumentService) {
  return defineTool({
    name: "get_knowledge_document",
    label: "查看知识库资料",
    description: "根据资料 ID 查看当前 Agent 已绑定知识库中的单份资料详情与可提取正文。",
    promptSnippet: "检索结果需要更多上下文时，使用 get_knowledge_document 读取资料详情。",
    parameters: Type.Object({ documentId: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId, params) {
      try {
        return success(await service.getDocumentForAgent(agentId, params.documentId));
      } catch (error) {
        return failure(error instanceof Error ? error.message : "读取知识库资料失败");
      }
    },
  });
}

/**
 * 汇集当前 Agent 已绑定知识库的管理操作，避免为低频操作长期注册多份工具 schema。
 *
 * @param agentId 当前 Pi Runtime 所属 Agent
 * @param service 受 Agent 作用域约束的知识库管理服务
 * @param files 当前 Agent 工作区资料读取能力
 */
export function createManageKnowledgeBaseTool(agentId: string, service: KnowledgeBaseManagementService, files: KnowledgeWorkspaceFileReader) {
  return defineTool({
    name: "manage_knowledge_base",
    label: "管理知识库",
    description: "列出、创建、编辑、导入或删除当前 Agent 已绑定的知识库和资料。删除知识库会清理全部资料、索引和所有 Agent 绑定。",
    promptSnippet: "需要管理知识库时，使用 manage_knowledge_base；删除知识库前必须先用 action=list 确认 ID。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("create"),
        Type.Literal("modify_knowladge_base"),
        Type.Literal("upload_documents"),
        Type.Literal("delete_base"),
        Type.Literal("delete_document"),
      ]),
      knowledgeBaseId: Type.Optional(Type.String({ minLength: 1 })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      description: Type.Optional(Type.String({ maxLength: 300 })),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10 })),
      documentId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolCallId, params) {
      try {
        if (params.action === "list") return success(await service.listBasesForAgent(agentId));
        if (params.action === "create") {
          return success(await service.createBaseForAgent(agentId, { name: requiredName(params.name), ...(params.description !== undefined ? { description: params.description } : {}) }));
        }
        const knowledgeBaseId = requiredValue(params.knowledgeBaseId, "请提供 knowledgeBaseId");
        if (params.action === "modify_knowladge_base") {
          if (params.name === undefined && params.description === undefined) throw new Error("至少提供名称或说明");
          return success(await service.updateBaseForAgent(agentId, knowledgeBaseId, {
            ...(params.name !== undefined ? { name: requiredName(params.name) } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
          }));
        }
        if (params.action === "upload_documents") {
          if (!Array.isArray(params.paths) || params.paths.length === 0) throw new Error("至少提供一份工作区资料");
          const documents: KnowledgeDocument[] = [];
          let totalBytes = 0;
          for (const path of params.paths) {
            const upload = await files.readFile(agentId, path, MAX_KNOWLEDGE_FILE_BYTES);
            if (!SUPPORTED_MEDIA_TYPES.has(upload.mediaType)) throw new Error("仅支持 TXT、Markdown、PDF 与 DOCX 文件");
            totalBytes += upload.content?.byteLength ?? 0;
            if (totalBytes > SYSTEM_LIMITS.knowledgeUploadBytes) throw new Error("单次导入资料总量不能超过 50 MB");
            // 顺序读取并立即解析，避免 Agent tool 在进入 Service 栅栏前持有 10 份大 Buffer。
            documents.push(...await service.uploadDocumentsForAgent(agentId, knowledgeBaseId, [upload]));
          }
          return success({ knowledgeBaseId, documents });
        }
        if (params.action === "delete_document") {
          const documentId = requiredValue(params.documentId, "请提供 documentId");
          await service.removeDocumentForAgent(agentId, knowledgeBaseId, documentId);
          return success({ knowledgeBaseId, documentId, deleted: true });
        }
        await service.removeBaseForAgent(agentId, knowledgeBaseId);
        return success({ knowledgeBaseId, deleted: true, scope: "knowledge_base_with_documents_indexes_and_bindings" });
      } catch (error) {
        return failure(error instanceof Error ? error.message : "管理知识库失败");
      }
    },
  });
}

/** 返回非空的名称字段。 */
function requiredName(value: string | undefined): string {
  const name = value?.trim();
  if (!name) throw new Error("请提供知识库名称");
  return name;
}

/** 返回 action 所需的非空字符串字段。 */
function requiredValue(value: string | undefined, message: string): string {
  if (!value?.trim()) throw new Error(message);
  return value;
}

/** 返回提供给 Pi 模型的结构化成功结果。 */
function success(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

/** 返回可供 Pi 模型纠正参数的失败结果。 */
function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: {} };
}
