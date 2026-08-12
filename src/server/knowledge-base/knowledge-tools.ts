import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { SYSTEM_LIMITS } from "../core/limits";
import {
  emptyResponse,
  errorResponse,
  okResponse,
  partialResponse,
  toPiToolResult,
  type ToolWarning,
} from "../retrieval/tool-response";
import type {
  KnowledgeBaseSummary,
  KnowledgeDocument,
  KnowledgeReadInput,
  KnowledgeReadServiceResult,
  KnowledgeSearchInput,
  KnowledgeSearchServiceResult,
  KnowledgeUpload,
} from "./knowledge-base-service";

interface KnowledgeSearchService {
  searchForAgent(agentId: string, input: KnowledgeSearchInput): Promise<KnowledgeSearchServiceResult>;
}

interface KnowledgeReadService {
  readForAgent(agentId: string, input: KnowledgeReadInput): Promise<KnowledgeReadServiceResult>;
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

/** 创建只检索当前 Agent 授权知识库的工具。 */
export function createKnowledgeSearchTool(agentId: string, service: KnowledgeSearchService) {
  return defineTool({
    name: "knowledge_search",
    label: "检索知识库",
    description: "检索当前 Agent 可访问的知识库并返回带资料与切片位置的结果。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      knowledgeBaseIds: Type.Optional(Type.Array(
        Type.String({ minLength: 1 }),
        { minItems: 1, maxItems: 20, uniqueItems: true },
      )),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      try {
        const result = await service.searchForAgent(agentId, params);
        if (result.metadata.resultCount === 0) {
          return toPiToolResult(emptyResponse(result.data, result.metadata));
        }
        if (result.warnings.length > 0) {
          return toPiToolResult(partialResponse(result.data, result.metadata, result.warnings));
        }
        return toPiToolResult(okResponse(result.data, result.metadata));
      } catch (error) {
        return toPiToolResult(errorResponse(
          "KNOWLEDGE_SEARCH_FAILED",
          errorMessage(error, "知识库检索失败"),
          false,
        ));
      }
    },
  });
}

/** 创建读取知识库命中上下文或整篇正文片段的工具。 */
export function createKnowledgeReadTool(agentId: string, service: KnowledgeReadService) {
  return defineTool({
    name: "knowledge_read",
    label: "读取知识库资料",
    description: "读取知识库命中切片周围的上下文，或按偏移量读取资料正文。",
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("around_chunk"), Type.Literal("document")]),
      documentId: Type.String({ minLength: 1 }),
      anchorChunkId: Type.Optional(Type.String({ minLength: 1 })),
      beforeChunks: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      afterChunks: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      maxCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: 50_000 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      try {
        const input = validateKnowledgeReadInput(params);
        const result = await service.readForAgent(agentId, input);
        const warnings: ToolWarning[] = [...result.warnings];
        if (result.metadata.truncated && !warnings.some(({ code }) => code === "CONTENT_TRUNCATED")) {
          warnings.push({ code: "CONTENT_TRUNCATED", message: "返回正文已按字符上限截断" });
        }
        if (warnings.length > 0) {
          return toPiToolResult(partialResponse(result.data, result.metadata, warnings));
        }
        return toPiToolResult(okResponse(result.data, result.metadata));
      } catch (error) {
        return toPiToolResult(errorResponse(
          "KNOWLEDGE_READ_FAILED",
          errorMessage(error, "读取知识库资料失败"),
          false,
        ));
      }
    },
  });
}

/** 创建当前 Agent 作用域内的知识库管理工具。 */
export function createKnowledgeManageTool(
  agentId: string,
  service: KnowledgeBaseManagementService,
  files: KnowledgeWorkspaceFileReader,
) {
  return defineTool({
    name: "knowledge_manage",
    label: "管理知识库",
    description: "列出、创建、更新、导入或删除当前 Agent 可管理的知识库与资料。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list_bases"),
        Type.Literal("create_base"),
        Type.Literal("update_base"),
        Type.Literal("upload_documents"),
        Type.Literal("delete_document"),
        Type.Literal("delete_base"),
      ]),
      knowledgeBaseId: Type.Optional(Type.String({ minLength: 1 })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      description: Type.Optional(Type.String({ maxLength: 300 })),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10 })),
      documentId: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      try {
        if (params.action === "list_bases") {
          return toPiToolResult(okResponse(
            { knowledgeBases: await service.listBasesForAgent(agentId) },
            { action: params.action },
          ));
        }
        if (params.action === "create_base") {
          if (params.name === undefined) throw new TypeError("create_base 操作必须提供 name");
          const knowledgeBase = await service.createBaseForAgent(agentId, {
            name: params.name.trim(),
            ...(params.description !== undefined ? { description: params.description } : {}),
          });
          return toPiToolResult(okResponse({ knowledgeBase }, { action: params.action }));
        }
        if (params.action === "update_base") {
          if (params.knowledgeBaseId === undefined) throw new TypeError("update_base 操作必须提供 knowledgeBaseId");
          if (params.name === undefined && params.description === undefined) throw new Error("至少提供名称或说明");
          const knowledgeBase = await service.updateBaseForAgent(agentId, params.knowledgeBaseId, {
            ...(params.name !== undefined ? { name: params.name.trim() } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
          });
          return toPiToolResult(okResponse({ knowledgeBase }, { action: params.action }));
        }
        if (params.action === "upload_documents") {
          if (params.knowledgeBaseId === undefined) throw new TypeError("upload_documents 操作必须提供 knowledgeBaseId");
          if (params.paths === undefined) throw new TypeError("upload_documents 操作必须提供 paths");
          const documents: KnowledgeDocument[] = [];
          let totalBytes = 0;
          for (const path of params.paths) {
            const upload = await files.readFile(agentId, path, MAX_KNOWLEDGE_FILE_BYTES);
            if (!SUPPORTED_MEDIA_TYPES.has(upload.mediaType)) throw new Error("仅支持 TXT、Markdown、PDF 与 DOCX 文件");
            totalBytes += upload.content?.byteLength ?? 0;
            if (totalBytes > SYSTEM_LIMITS.knowledgeUploadBytes) throw new Error("单次导入资料总量不能超过 50 MB");
            // 顺序读取并立即解析，避免在进入 Service 栅栏前同时持有多份大文件。
            documents.push(...await service.uploadDocumentsForAgent(agentId, params.knowledgeBaseId, [upload]));
          }
          return toPiToolResult(okResponse(
            { knowledgeBaseId: params.knowledgeBaseId, documents },
            { action: params.action },
          ));
        }
        if (params.action === "delete_document") {
          if (params.knowledgeBaseId === undefined) throw new TypeError("delete_document 操作必须提供 knowledgeBaseId");
          if (params.documentId === undefined) throw new TypeError("delete_document 操作必须提供 documentId");
          await service.removeDocumentForAgent(agentId, params.knowledgeBaseId, params.documentId);
          return toPiToolResult(okResponse({
            knowledgeBaseId: params.knowledgeBaseId,
            documentId: params.documentId,
            deleted: true,
          }, { action: params.action }));
        }
        if (params.knowledgeBaseId === undefined) throw new TypeError("delete_base 操作必须提供 knowledgeBaseId");
        await service.removeBaseForAgent(agentId, params.knowledgeBaseId);
        return toPiToolResult(okResponse({
          knowledgeBaseId: params.knowledgeBaseId,
          deleted: true,
          scope: "knowledge_base_with_documents_indexes_and_bindings",
        }, { action: params.action }));
      } catch (error) {
        return toPiToolResult(errorResponse(
          "KNOWLEDGE_MANAGE_FAILED",
          errorMessage(error, "管理知识库失败"),
          false,
        ));
      }
    },
  });
}

/** 在业务读取前校验 mode 对应的条件字段，并收窄为服务层输入。 */
function validateKnowledgeReadInput(params: {
  mode: "around_chunk" | "document";
  documentId: string;
  anchorChunkId?: string;
  beforeChunks?: number;
  afterChunks?: number;
  offset?: number;
  maxCharacters?: number;
}): KnowledgeReadInput {
  if (params.mode === "around_chunk") {
    if (params.anchorChunkId === undefined) {
      throw new TypeError("around_chunk 模式必须提供 anchorChunkId");
    }
    return {
      mode: params.mode,
      documentId: params.documentId,
      anchorChunkId: params.anchorChunkId,
      ...(params.beforeChunks !== undefined ? { beforeChunks: params.beforeChunks } : {}),
      ...(params.afterChunks !== undefined ? { afterChunks: params.afterChunks } : {}),
      ...(params.maxCharacters !== undefined ? { maxCharacters: params.maxCharacters } : {}),
    };
  }
  return {
    mode: params.mode,
    documentId: params.documentId,
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
    ...(params.maxCharacters !== undefined ? { maxCharacters: params.maxCharacters } : {}),
  };
}

/** 将受控业务错误转换为工具可见消息。 */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
