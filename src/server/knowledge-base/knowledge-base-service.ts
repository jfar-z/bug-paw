import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { KnowledgeBaseDocument } from "../../shared/knowledge-base-contracts";
import type { DataPaths } from "../paths";
import { chunkKnowledgeText } from "./chunker";
import { parseKnowledgeDocument } from "./document-parser";
import {
  createKnowledgeLanceIndex,
  type KnowledgeIndexChunk,
  type KnowledgeIndexSearchResult,
  type KnowledgeLanceIndex,
} from "./lance-index";
import type { KnowledgeRepository } from "./knowledge-repository";
import { DomainError, toSafePublicMessage } from "../core/errors";
import { KeyedMutex } from "../core/keyed-mutex";
import { SYSTEM_LIMITS } from "../core/limits";

/** 知识库资料的公开元数据。 */
export interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  name: string;
  mediaType: string;
  status: "indexed" | "needs_ocr" | "failed";
  failureReason?: string;
  createdAt: string;
  text?: string;
  textTruncated?: boolean;
}

/** 知识库中保存的一份原始资料文件。 */
export interface KnowledgeDocumentSource {
  name: string;
  mediaType: string;
  path: string;
  size: number;
}

/** 管理端上传的资料内容。 */
export interface KnowledgeUpload {
  name: string;
  mediaType: string;
  /** Agent 工具导入的小文件可直接传内容。 */
  content?: Buffer;
  /** HTTP 上传先流式落临时盘，避免整批文件同时驻留内存。 */
  sourcePath?: string;
}

/** HTTP multipart 的单文件流，由 Service 在全局预算内顺序暂存。 */
export interface KnowledgeStreamUpload {
  name: string;
  mediaType: string;
  stream: Readable;
}

/** 创建知识库的管理端输入。 */
export interface CreateKnowledgeBaseRequest {
  name: string;
  description?: string;
  agentIds?: string[];
}

/** 管理端更新知识库的输入。 */
export interface UpdateKnowledgeBaseRequest {
  name?: string;
  description?: string;
  agentIds?: string[];
}

/** 管理端查看的知识库详情。 */
export interface KnowledgeBaseDetail extends KnowledgeBaseDocument {
  agentIds: string[];
  documents: KnowledgeDocument[];
}

/** Agent 管理工具可见的知识库安全摘要。 */
export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 知识库服务依赖。 */
export interface KnowledgeBaseServiceDependencies {
  paths: DataPaths;
  store: KnowledgeRepository;
  agentExists(agentId: string): Promise<boolean>;
  index?: KnowledgeLanceIndex;
  /** 可选的语义向量服务；未配置时保留全文检索能力。 */
  embeddingClient?: {
    embedDocuments(input: string[]): Promise<number[][]>;
    embedQuery(query: string): Promise<number[]>;
  };
  /** 控制资料上传与查询是否使用语义向量索引。 */
  isSemanticSearchEnabled?(): Promise<boolean>;
  stageDeletion?: (kind: "knowledge-base" | "knowledge-document", entityId: string, paths: string[]) => Promise<{ commit(): Promise<void>; rollback(): Promise<void> }>;
}

/** 独立知识库的应用服务。 */
export interface KnowledgeBaseService {
  listBases(): Promise<KnowledgeBaseDetail[]>;
  listBasesForAgent(agentId: string): Promise<KnowledgeBaseSummary[]>;
  getBase(knowledgeBaseId: string): Promise<KnowledgeBaseDetail | undefined>;
  createBase(input: CreateKnowledgeBaseRequest): Promise<KnowledgeBaseDetail>;
  createBaseForAgent(agentId: string, input: Omit<CreateKnowledgeBaseRequest, "agentIds">): Promise<KnowledgeBaseSummary>;
  updateBase(knowledgeBaseId: string, input: UpdateKnowledgeBaseRequest): Promise<KnowledgeBaseDetail | undefined>;
  updateBaseForAgent(agentId: string, knowledgeBaseId: string, input: Omit<UpdateKnowledgeBaseRequest, "agentIds">): Promise<KnowledgeBaseSummary>;
  removeBase(knowledgeBaseId: string): Promise<boolean>;
  removeBaseForAgent(agentId: string, knowledgeBaseId: string): Promise<void>;
  uploadDocuments(knowledgeBaseId: string, uploads: KnowledgeUpload[]): Promise<KnowledgeDocument[]>;
  uploadDocumentStreams(knowledgeBaseId: string, uploads: AsyncIterable<KnowledgeStreamUpload>, signal?: AbortSignal): Promise<KnowledgeDocument[]>;
  uploadDocumentsForAgent(agentId: string, knowledgeBaseId: string, uploads: KnowledgeUpload[]): Promise<KnowledgeDocument[]>;
  getDocument(knowledgeBaseId: string, documentId: string): Promise<KnowledgeDocument | undefined>;
  getDocumentChunks(knowledgeBaseId: string, documentId: string): Promise<KnowledgeIndexChunk[] | undefined>;
  getDocumentSource(knowledgeBaseId: string, documentId: string): Promise<KnowledgeDocumentSource | undefined>;
  removeDocument(knowledgeBaseId: string, documentId: string): Promise<void>;
  removeDocumentForAgent(agentId: string, knowledgeBaseId: string, documentId: string): Promise<void>;
  searchBase(knowledgeBaseId: string, query: string, limit?: number): Promise<KnowledgeIndexSearchResult[]>;
  searchForAgent(agentId: string, input: { query: string; knowledgeBaseId?: string; limit?: number }): Promise<KnowledgeIndexSearchResult[]>;
  getDocumentForAgent(agentId: string, documentId: string): Promise<KnowledgeDocument>;
  rebuildSemanticIndex(): Promise<{ totalBases: number; rebuiltBases: number; failedBases: string[] }>;
}

/**
 * 创建统一管理资料、索引与 Agent 授权的知识库服务。
 *
 * @param dependencies 应用路径、元数据仓库与 Agent 查询依赖
 */
export function createKnowledgeBaseService(dependencies: KnowledgeBaseServiceDependencies): KnowledgeBaseService {
  const index = dependencies.index ?? createKnowledgeLanceIndex(join(dependencies.paths.knowledgeDir, "indexes"));
  const mutations = new KeyedMutex();
  const uploadGate = new KeyedMutex();
  const listBaseDetails = async (): Promise<KnowledgeBaseDetail[]> => {
    const [bases, bindings, documents] = await Promise.all([
      dependencies.store.listBases(),
      dependencies.store.listBindings(),
      dependencies.store.listAllDocuments(),
    ]);
    return bases.map((base) => toDetail(base, bindings, documents));
  };
  const getBaseDetail = async (knowledgeBaseId: string): Promise<KnowledgeBaseDetail | undefined> => {
    const base = await dependencies.store.getBase(knowledgeBaseId);
    if (!base) return undefined;
    const [bindings, documents] = await Promise.all([
      dependencies.store.listBindings(),
      dependencies.store.listAllDocuments(),
    ]);
    return toDetail(base, bindings, documents);
  };
  const getDocumentDetail = async (knowledgeBaseId: string, documentId: string, textLimit?: number): Promise<KnowledgeDocument | undefined> => {
    const document = (await dependencies.store.listDocuments(knowledgeBaseId)).find((item) => item.id === documentId);
    if (!document || document.status !== "indexed") return document;
    const text = await readFile(join(dependencies.paths.knowledgeDir, "sources", knowledgeBaseId, document.id, "text.txt"), "utf8");
    const truncated = textLimit !== undefined && text.length > textLimit;
    return { ...document, text: truncated ? text.slice(0, textLimit) : text, textTruncated: truncated };
  };
  const filterIndexedResults = async (knowledgeBaseId: string, results: KnowledgeIndexSearchResult[]) => {
    const indexed = new Set((await dependencies.store.listDocuments(knowledgeBaseId))
      .filter((document) => document.status === "indexed")
      .map((document) => document.id));
    return results.filter((result) => indexed.has(result.documentId));
  };
  /** 将资料切片分批转换为向量，避免一次请求超过兼容服务的输入限制。 */
  const createVectors = async (chunks: ReturnType<typeof chunkKnowledgeText>) => {
    if (!dependencies.embeddingClient || !index.upsertVectorChunks) throw new Error("尚未启用语义检索");
    const vectors: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += 64) {
      vectors.push(...await dependencies.embeddingClient.embedDocuments(chunks.slice(offset, offset + 64).map((chunk) => chunk.text)));
    }
    return vectors;
  };
  /** 未注入开关的测试或旧调用方，按是否具备向量客户端保持既有语义行为。 */
  const isSemanticSearchEnabled = async () => dependencies.isSemanticSearchEnabled
    ? dependencies.isSemanticSearchEnabled()
    : Boolean(dependencies.embeddingClient);
  /** 基于已解析的资料文本重建全文与语义索引。 */
  const rebuildSemanticIndex = async () => {
    const bases = await dependencies.store.listBases();
    const failedBases: string[] = [];
    let rebuiltBases = 0;
    for (const base of bases) {
      try {
        await mutations.run(base.id, async () => {
          const documents = (await dependencies.store.listDocuments(base.id)).filter((document) => document.status === "indexed");
          for (const document of documents) {
            const text = await readFile(join(dependencies.paths.knowledgeDir, "sources", base.id, document.id, "text.txt"), "utf8");
            const chunks = chunkKnowledgeText(text, { maxLength: 800, overlap: 120 });
            const vectors = await createVectors(chunks);
            // 全部向量生成成功后才替换该资料索引，失败时仍保留可用的旧索引。
            await index.removeDocument(base.id, document.id);
            const indexedChunks = chunks.map((chunk) => ({ chunkId: `${document.id}:${chunk.index}`, documentId: document.id, index: chunk.index, text: chunk.text, page: 1 }));
            await index.upsertChunks(base.id, indexedChunks);
            await index.upsertVectorChunks?.(base.id, indexedChunks.map((chunk, index) => ({ ...chunk, vector: vectors[index] })));
          }
        });
        rebuiltBases += 1;
      } catch {
        failedBases.push(base.id);
      }
    }
    return { totalBases: bases.length, rebuiltBases, failedBases };
  };
  /** 确认 Agent 对知识库拥有资料维护权限。 */
  const requireManagedBase = async (agentId: string, knowledgeBaseId: string): Promise<void> => {
    if (!(await dependencies.store.listBaseIdsForAgent(agentId)).includes(knowledgeBaseId)) {
      throw new Error("无权管理该知识库");
    }
  };
  const createBase = async (input: CreateKnowledgeBaseRequest): Promise<KnowledgeBaseDetail> => {
    const agentIds = input.agentIds ?? [];
    if (!(await Promise.all(agentIds.map((agentId) => dependencies.agentExists(agentId)))).every(Boolean)) {
      throw new TypeError("绑定的 Agent 不存在");
    }
    const base = await dependencies.store.createBaseWithBindings(input, agentIds);
    return (await getBaseDetail(base.id)) ?? { ...base, agentIds, documents: [] };
  };
  const updateBaseUnlocked = async (knowledgeBaseId: string, input: UpdateKnowledgeBaseRequest): Promise<KnowledgeBaseDetail | undefined> => {
    if (input.agentIds !== undefined && !(await Promise.all(input.agentIds.map((agentId) => dependencies.agentExists(agentId)))).every(Boolean)) {
      throw new TypeError("绑定的 Agent 不存在");
    }
    const updated = await dependencies.store.updateBaseWithBindings(knowledgeBaseId, input, input.agentIds);
    return updated ? getBaseDetail(knowledgeBaseId) : undefined;
  };
  const removeBaseUnlocked = async (knowledgeBaseId: string): Promise<boolean> => {
    if (!(await dependencies.store.getBase(knowledgeBaseId))) return false;
    const paths = [
      join(dependencies.paths.knowledgeDir, "sources", knowledgeBaseId),
      join(dependencies.paths.knowledgeDir, "indexes", knowledgeBaseId),
    ];
    const transaction = await dependencies.stageDeletion?.("knowledge-base", knowledgeBaseId, paths);
    const staged = transaction ? [] : await stageDirectories(paths, join(dependencies.paths.trashDir, "knowledge", knowledgeBaseId));
    try {
      const removed = await dependencies.store.removeBase(knowledgeBaseId);
      if (!removed) {
        if (transaction) await transaction.rollback(); else await rollbackStaged(staged);
        return false;
      }
    } catch (error) {
      try {
        if (transaction) await transaction.rollback(); else await rollbackStaged(staged);
      } catch (rollbackError) {
        throw new DomainError("KNOWLEDGE_ROLLBACK_FAILED", "知识库删除失败且文件恢复未完成", undefined, { cause: rollbackError });
      }
      throw error;
    }
    if (transaction) await transaction.commit(); else await discardStaged(staged);
    return true;
  };
  const removeBase = (knowledgeBaseId: string): Promise<boolean> => mutations.run(
    knowledgeBaseId,
    () => removeBaseUnlocked(knowledgeBaseId),
  );
  const uploadDocumentsUnlocked = async (knowledgeBaseId: string, uploads: KnowledgeUpload[], signal?: AbortSignal): Promise<KnowledgeDocument[]> => {
    if (!(await dependencies.store.getBase(knowledgeBaseId))) throw new Error("知识库不存在");
    const results: KnowledgeDocument[] = [];
    for (const upload of uploads) {
      signal?.throwIfAborted();
      const id = randomUUID();
      const sourceDir = join(dependencies.paths.knowledgeDir, "sources", knowledgeBaseId, id);
      const name = basename(upload.name.replaceAll("\\", "/")) || "document";
      await mkdir(sourceDir, { recursive: true, mode: 0o700 });
      const sourcePath = join(sourceDir, "source");
      if (upload.sourcePath) await copyFile(upload.sourcePath, sourcePath);
      else if (upload.content) await writeFile(sourcePath, upload.content, { mode: 0o600 });
      else throw new TypeError("知识资料缺少内容");
      let document: KnowledgeDocument;
      let attemptedIndex = false;
      try {
        // 压缩文档在受限独立子进程中解析；这里只保留当前文档的正文与切片。
        const parsed = await parseKnowledgeDocument({ mediaType: upload.mediaType, path: sourcePath, signal });
        if (parsed.status === "needs_ocr") {
          document = { id, knowledgeBaseId, name, mediaType: upload.mediaType, status: "needs_ocr", failureReason: "该 PDF 没有可提取的文字层，需要 OCR", createdAt: new Date().toISOString() };
        } else {
          const chunks = chunkKnowledgeText(parsed.text, { maxLength: 800, overlap: 120 });
          if (chunks.length > SYSTEM_LIMITS.knowledgeChunksPerDocument) throw new RangeError("资料切片数量超过系统上限");
          await writeFile(join(sourceDir, "text.txt"), parsed.text, { encoding: "utf8", mode: 0o600 });
          attemptedIndex = true;
          const indexedChunks = chunks.map((chunk) => ({ chunkId: `${id}:${chunk.index}`, documentId: id, index: chunk.index, text: chunk.text, page: 1 }));
          await index.upsertChunks(knowledgeBaseId, indexedChunks);
          if (await isSemanticSearchEnabled()) {
            const vectors = await createVectors(chunks);
            await index.upsertVectorChunks?.(knowledgeBaseId, indexedChunks.map((chunk, index) => ({ ...chunk, vector: vectors[index] })));
          }
          document = { id, knowledgeBaseId, name, mediaType: upload.mediaType, status: "indexed", createdAt: new Date().toISOString() };
        }
      } catch (error) {
        if (attemptedIndex) {
          try {
            await index.removeDocument(knowledgeBaseId, id);
          } catch (cleanupError) {
            throw new DomainError("KNOWLEDGE_ROLLBACK_FAILED", "资料索引失败且残留切片未能清理", undefined, {
              cause: new AggregateError([error, cleanupError]),
            });
          }
        }
        document = { id, knowledgeBaseId, name, mediaType: upload.mediaType, status: "failed", failureReason: toSafePublicMessage(error, "资料解析失败"), createdAt: new Date().toISOString() };
      }
      try {
        await dependencies.store.insertDocuments([document]);
      } catch (error) {
        const cleanup = await Promise.allSettled([
          index.removeDocument(knowledgeBaseId, document.id),
          rm(sourceDir, { recursive: true, force: true }),
        ]);
        if (cleanup.some((result) => result.status === "rejected")) {
          throw new DomainError("KNOWLEDGE_ROLLBACK_FAILED", "资料元数据提交失败且临时内容清理未完成", undefined, { cause: error });
        }
        throw error;
      }
      results.push(document);
    }
    return results;
  };
  const removeDocumentUnlocked = async (knowledgeBaseId: string, documentId: string): Promise<void> => {
    const document = (await dependencies.store.listDocuments(knowledgeBaseId)).find((item) => item.id === documentId);
    if (!document) throw new Error("资料不存在");
    const sourceDirectory = join(dependencies.paths.knowledgeDir, "sources", knowledgeBaseId, documentId);
    const transaction = await dependencies.stageDeletion?.("knowledge-document", documentId, [sourceDirectory]);
    const staged = transaction ? [] : await stageDirectories([sourceDirectory], join(dependencies.paths.trashDir, "knowledge", knowledgeBaseId, documentId));
    try {
      await index.removeDocument(knowledgeBaseId, documentId);
      if (!(await dependencies.store.removeDocument(knowledgeBaseId, documentId))) throw new Error("资料不存在");
    } catch (error) {
      try {
        if (transaction) await transaction.rollback(); else await rollbackStaged(staged);
        if (document.status === "indexed") {
          const text = await readFile(join(sourceDirectory, "text.txt"), "utf8");
          await index.removeDocument(knowledgeBaseId, documentId);
          await index.upsertChunks(knowledgeBaseId, chunkKnowledgeText(text, { maxLength: 800, overlap: 120 }).map((chunk) => ({
            chunkId: `${documentId}:${chunk.index}`, documentId, index: chunk.index, text: chunk.text, page: 1,
          })));
        }
      } catch (rollbackError) {
        throw new DomainError("KNOWLEDGE_ROLLBACK_FAILED", "资料删除失败且索引恢复未完成", undefined, { cause: rollbackError });
      }
      throw error;
    }
    if (transaction) await transaction.commit(); else await discardStaged(staged);
  };
  return {
    async listBases() {
      return listBaseDetails();
    },

    async listBasesForAgent(agentId) {
      const allowed = new Set(await dependencies.store.listBaseIdsForAgent(agentId));
      return (await listBaseDetails()).filter((base) => allowed.has(base.id)).map(toSummary);
    },

    async getBase(knowledgeBaseId) {
      return getBaseDetail(knowledgeBaseId);
    },

    createBase,

    async createBaseForAgent(agentId, input) {
      return toSummary(await createBase({ ...input, agentIds: [agentId] }));
    },

    async updateBase(knowledgeBaseId, input) {
      return mutations.run(knowledgeBaseId, () => updateBaseUnlocked(knowledgeBaseId, input));
    },

    async updateBaseForAgent(agentId, knowledgeBaseId, input) {
      return mutations.run(knowledgeBaseId, async () => {
        await requireManagedBase(agentId, knowledgeBaseId);
        const updated = await updateBaseUnlocked(knowledgeBaseId, input);
        if (!updated) throw new Error("知识库不存在");
        return toSummary(updated);
      });
    },

    removeBase,

    async removeBaseForAgent(agentId, knowledgeBaseId) {
      await mutations.run(knowledgeBaseId, async () => {
        await requireManagedBase(agentId, knowledgeBaseId);
        if (!await removeBaseUnlocked(knowledgeBaseId)) throw new Error("知识库不存在");
      });
    },

    async uploadDocuments(knowledgeBaseId, uploads) {
      return uploadGate.run("global", () => mutations.run(knowledgeBaseId, () => uploadDocumentsUnlocked(knowledgeBaseId, uploads)));
    },

    async uploadDocumentStreams(knowledgeBaseId, uploads, signal) {
      return uploadGate.run("global", () => mutations.run(knowledgeBaseId, async () => {
        signal?.throwIfAborted();
        const stagingRoot = join(dependencies.paths.knowledgeDir, "staging");
        await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
        const stagingDirectory = await mkdtemp(join(stagingRoot, "batch-"));
        const staged: KnowledgeUpload[] = [];
        let totalBytes = 0;
        try {
          for await (const upload of uploads) {
            signal?.throwIfAborted();
            const sourcePath = join(stagingDirectory, `${staged.length}.upload`);
            let fileBytes = 0;
            const counter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                fileBytes += chunk.byteLength;
                totalBytes += chunk.byteLength;
                if (fileBytes > 20 * 1024 * 1024 || totalBytes > SYSTEM_LIMITS.knowledgeUploadBytes) {
                  callback(new DomainError("KNOWLEDGE_UPLOAD_LIMIT", "知识资料上传超过系统字节预算"));
                  return;
                }
                callback(null, chunk);
              },
            });
            await pipeline(upload.stream, counter, createWriteStream(sourcePath, { flags: "wx", mode: 0o600 }), { signal });
            staged.push({ name: upload.name, mediaType: upload.mediaType, sourcePath });
          }
          if (staged.length === 0) throw new DomainError("EMPTY_UPLOAD", "至少选择一个资料文件");
          return await uploadDocumentsUnlocked(knowledgeBaseId, staged, signal);
        } finally {
          await rm(stagingDirectory, { recursive: true, force: true });
        }
      }));
    },

    async uploadDocumentsForAgent(agentId, knowledgeBaseId, uploads) {
      return uploadGate.run("global", () => mutations.run(knowledgeBaseId, async () => {
        await requireManagedBase(agentId, knowledgeBaseId);
        return uploadDocumentsUnlocked(knowledgeBaseId, uploads);
      }));
    },

    async getDocument(knowledgeBaseId, documentId) {
      return getDocumentDetail(knowledgeBaseId, documentId);
    },

    async getDocumentChunks(knowledgeBaseId, documentId) {
      const document = (await dependencies.store.listDocuments(knowledgeBaseId)).find((item) => item.id === documentId);
      if (!document) return undefined;
      if (document.status !== "indexed") return [];
      return index.listDocumentChunks?.(knowledgeBaseId, documentId) ?? [];
    },

    async getDocumentSource(knowledgeBaseId, documentId) {
      const document = (await dependencies.store.listDocuments(knowledgeBaseId)).find((item) => item.id === documentId);
      if (!document) return undefined;
      const path = join(dependencies.paths.knowledgeDir, "sources", knowledgeBaseId, document.id, "source");
      return {
        name: document.name,
        mediaType: document.mediaType,
        path,
        size: (await stat(path)).size,
      };
    },

    async removeDocument(knowledgeBaseId, documentId) {
      return mutations.run(knowledgeBaseId, () => removeDocumentUnlocked(knowledgeBaseId, documentId));
    },

    async removeDocumentForAgent(agentId, knowledgeBaseId, documentId) {
      await mutations.run(knowledgeBaseId, async () => {
        await requireManagedBase(agentId, knowledgeBaseId);
        await removeDocumentUnlocked(knowledgeBaseId, documentId);
      });
    },

    async searchBase(knowledgeBaseId, query, limit = 10) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) throw new TypeError("检索关键词不能为空");
      return mutations.run(knowledgeBaseId, async () => {
        if (!(await dependencies.store.getBase(knowledgeBaseId))) throw new Error("知识库不存在");
        const normalizedLimit = normalizeLimit(limit);
        if (await isSemanticSearchEnabled() && dependencies.embeddingClient && index.searchVectors) {
          try {
            const vector = await dependencies.embeddingClient.embedQuery(normalizedQuery);
            const semanticResults = await index.searchVectors(knowledgeBaseId, vector, normalizedLimit);
            if (semanticResults.length > 0) return filterIndexedResults(knowledgeBaseId, semanticResults);
          } catch {
            // 兼容没有 Embedding 配置、暂时不可用或尚未重建向量的知识库。
          }
        }
        return filterIndexedResults(knowledgeBaseId, await index.search(knowledgeBaseId, normalizedQuery, normalizedLimit));
      });
    },

    async searchForAgent(agentId, input) {
      const baseIds = await dependencies.store.listBaseIdsForAgent(agentId);
      const selected = input.knowledgeBaseId ? baseIds.filter((id) => id === input.knowledgeBaseId) : baseIds;
      if (selected.length === 0) throw new Error("没有可访问的知识库");
      const normalizedQuery = input.query.trim();
      if (!normalizedQuery) throw new TypeError("检索关键词不能为空");
      const limit = normalizeLimit(input.limit ?? 5);
      const results = await Promise.all(selected.map((baseId) => mutations.run(baseId, async () => {
        const stillAllowed = (await dependencies.store.listBaseIdsForAgent(agentId)).includes(baseId);
        if (!stillAllowed || !(await dependencies.store.getBase(baseId))) return [];
        if (await isSemanticSearchEnabled() && dependencies.embeddingClient && index.searchVectors) {
          try {
            const vector = await dependencies.embeddingClient.embedQuery(normalizedQuery);
            const semanticResults = await index.searchVectors(baseId, vector, limit);
            if (semanticResults.length > 0) return filterIndexedResults(baseId, semanticResults);
          } catch {
            // 某一知识库的语义检索异常不能影响同一 Agent 的其他知识库。
          }
        }
        return filterIndexedResults(baseId, await index.search(baseId, normalizedQuery, limit));
      })));
      return results.flat().slice(0, limit);
    },

    async getDocumentForAgent(agentId, documentId) {
      const document = (await dependencies.store.listAllDocuments()).find((item) => item.id === documentId);
      if (!document) throw new Error("资料不存在");
      const allowed = (await dependencies.store.listBaseIdsForAgent(agentId)).includes(document.knowledgeBaseId);
      if (!allowed) throw new Error("无权访问该知识库资料");
      return getDocumentDetail(document.knowledgeBaseId, document.id, 12_000).then((result) => result ?? document);
    },

    rebuildSemanticIndex,
  };
}

interface StagedDirectory {
  original: string;
  staged: string;
}

/** 把待删除目录先移入同一数据卷的回收区，以便数据库失败时原子恢复。 */
async function stageDirectories(paths: string[], trashRoot: string): Promise<StagedDirectory[]> {
  const staged: StagedDirectory[] = [];
  try {
    for (const original of paths) {
      if (!(await exists(original))) continue;
      const target = join(trashRoot, `${randomUUID()}-${basename(original)}`);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(original, target);
      staged.push({ original, staged: target });
    }
    return staged;
  } catch (error) {
    await rollbackStaged(staged);
    throw error;
  }
}

async function rollbackStaged(staged: StagedDirectory[]): Promise<void> {
  const results = await Promise.allSettled([...staged].reverse().map(async (item) => {
    await mkdir(dirname(item.original), { recursive: true, mode: 0o700 });
    await rename(item.staged, item.original);
  }));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "知识库暂存目录恢复失败");
}

async function discardStaged(staged: StagedDirectory[]): Promise<void> {
  for (const item of staged) {
    try {
      await rm(item.staged, { recursive: true, force: true });
    } catch {
      // 元数据已提交时保留回收区副本，后续运维可安全清理，不能反向伪造删除失败。
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 将底层元数据组合为管理端可展示的详情。 */
function toDetail(base: KnowledgeBaseDocument, bindings: Array<{ knowledgeBaseId: string; agentId: string }>, documents: KnowledgeDocument[]): KnowledgeBaseDetail {
  return {
    ...base,
    agentIds: bindings.filter((binding) => binding.knowledgeBaseId === base.id).map((binding) => binding.agentId),
    documents: documents.filter((document) => document.knowledgeBaseId === base.id),
  };
}

/** 将管理详情收敛为不泄露其他 Agent 绑定关系的摘要。 */
function toSummary(base: KnowledgeBaseDetail): KnowledgeBaseSummary {
  return {
    id: base.id,
    name: base.name,
    description: base.description,
    documentCount: base.documents.length,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  };
}

/** 约束检索结果数量，避免单次查询占用过多上下文。 */
function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(Math.floor(value), 20));
}
