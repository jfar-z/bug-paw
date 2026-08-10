import { Index, connect } from "@lancedb/lancedb";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** 写入 LanceDB 的知识库文本切片。 */
export interface KnowledgeIndexChunk {
  chunkId: string;
  documentId: string;
  index: number;
  text: string;
  page?: number;
}

/** 关键词检索命中的知识库切片。 */
export interface KnowledgeIndexSearchResult extends KnowledgeIndexChunk {
  score?: number;
}

/** 带语义向量的知识库切片。 */
export interface KnowledgeVectorIndexChunk extends KnowledgeIndexChunk {
  vector: number[];
}

/** 知识库全文索引接口。 */
export interface KnowledgeLanceIndex {
  upsertChunks(knowledgeBaseId: string, chunks: KnowledgeIndexChunk[]): Promise<void>;
  upsertVectorChunks?(knowledgeBaseId: string, chunks: KnowledgeVectorIndexChunk[]): Promise<void>;
  /** 读取指定资料已落库的全文切片，供管理端核对索引内容。 */
  listDocumentChunks?(knowledgeBaseId: string, documentId: string): Promise<KnowledgeIndexChunk[]>;
  search(knowledgeBaseId: string, query: string, limit: number): Promise<KnowledgeIndexSearchResult[]>;
  searchVectors?(knowledgeBaseId: string, vector: number[], limit: number): Promise<KnowledgeIndexSearchResult[]>;
  removeDocument(knowledgeBaseId: string, documentId: string): Promise<void>;
}

/**
 * 创建每个知识库独立目录的 LanceDB 全文索引。
 *
 * @param indexesRoot 索引数据根目录
 */
export function createKnowledgeLanceIndex(indexesRoot: string): KnowledgeLanceIndex {
  return {
    async upsertChunks(knowledgeBaseId, chunks) {
      if (chunks.length === 0) return;
      const connection = await openConnection(indexesRoot, knowledgeBaseId);
      const tableNames = await connection.tableNames();
      const rows = chunks.map((chunk) => ({ ...chunk, page: chunk.page ?? 1 }));
      const table = tableNames.includes("chunks")
        ? await connection.openTable("chunks")
        : await connection.createTable("chunks", rows);
      if (tableNames.includes("chunks")) {
        await table.add(rows);
      }
      await table.createIndex("text", {
        config: Index.fts({
          baseTokenizer: "ngram",
          ngramMinLength: 2,
          ngramMaxLength: 3,
          stem: false,
          removeStopWords: false,
        }),
        replace: true,
      });
    },

    async search(knowledgeBaseId, query, limit) {
      const connection = await openConnection(indexesRoot, knowledgeBaseId);
      if (!(await connection.tableNames()).includes("chunks")) return [];
      const rows = await connection.openTable("chunks").then((table) => table.search(query, "fts").limit(limit).toArray());
      return rows.map((row) => ({
        chunkId: String(row.chunkId),
        documentId: String(row.documentId),
        index: Number(row.index),
        text: String(row.text),
        ...(typeof row.page === "number" ? { page: row.page } : {}),
        ...(typeof row._score === "number" ? { score: row._score } : {}),
      }));
    },

    async listDocumentChunks(knowledgeBaseId, documentId) {
      const connection = await openConnection(indexesRoot, knowledgeBaseId);
      if (!(await connection.tableNames()).includes("chunks")) return [];
      const safeDocumentId = documentId.replaceAll("'", "''");
      const rows = await connection.openTable("chunks")
        .then((table) => table.query().where(`documentId = '${safeDocumentId}'`).toArray());
      return rows.map((row) => ({
        chunkId: String(row.chunkId),
        documentId: String(row.documentId),
        index: Number(row.index),
        text: String(row.text),
        ...(typeof row.page === "number" ? { page: row.page } : {}),
      })).sort((left, right) => left.index - right.index || left.chunkId.localeCompare(right.chunkId));
    },

    async upsertVectorChunks(knowledgeBaseId, chunks) {
      if (chunks.length === 0) return;
      const dimensions = chunks[0].vector.length;
      if (dimensions === 0 || chunks.some((chunk) => chunk.vector.length !== dimensions || chunk.vector.some((value) => !Number.isFinite(value)))) {
        throw new TypeError("知识向量格式无效");
      }
      const connection = await openConnection(indexesRoot, knowledgeBaseId);
      const tableNames = await connection.tableNames();
      const rows = chunks.map((chunk) => ({ ...chunk, page: chunk.page ?? 1 }));
      const table = tableNames.includes("vectors")
        ? await connection.openTable("vectors")
        : await connection.createTable("vectors", rows);
      if (tableNames.includes("vectors")) await table.add(rows);
    },

    async searchVectors(knowledgeBaseId, vector, limit) {
      if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) throw new TypeError("检索向量格式无效");
      const connection = await openConnection(indexesRoot, knowledgeBaseId);
      if (!(await connection.tableNames()).includes("vectors")) return [];
      const rows = await connection.openTable("vectors")
        .then((table) => table.vectorSearch(new Float32Array(vector)).distanceType("cosine").limit(limit).toArray());
      return rows.map((row) => ({
        chunkId: String(row.chunkId),
        documentId: String(row.documentId),
        index: Number(row.index),
        text: String(row.text),
        ...(typeof row.page === "number" ? { page: row.page } : {}),
        ...(typeof row._distance === "number" ? { score: row._distance } : {}),
      }));
    },

    async removeDocument(knowledgeBaseId, documentId) {
      const connection = await openConnection(indexesRoot, knowledgeBaseId);
      if (!(await connection.tableNames()).includes("chunks")) return;
      const safeDocumentId = documentId.replaceAll("'", "''");
      await connection.openTable("chunks").then((table) => table.delete(`documentId = '${safeDocumentId}'`));
      if ((await connection.tableNames()).includes("vectors")) {
        await connection.openTable("vectors").then((table) => table.delete(`documentId = '${safeDocumentId}'`));
      }
    },
  };
}

/** 为单个知识库创建受根目录约束的本地连接。 */
async function openConnection(indexesRoot: string, knowledgeBaseId: string) {
  const root = resolve(indexesRoot);
  const directory = resolve(root, knowledgeBaseId);
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) {
    throw new TypeError("知识库索引路径无效");
  }
  await mkdir(join(directory), { recursive: true, mode: 0o700 });
  return connect(directory);
}
