import { randomUUID } from "node:crypto";

import type {
  CreateKnowledgeBaseInput,
  KnowledgeBaseBinding,
  KnowledgeBaseDocument,
  UpdateKnowledgeBaseInput,
} from "../../shared/knowledge-base-contracts";
import type { Database } from "../database/database";

/** SQLite 中保存的知识资料元数据，不包含原文件和向量内容。 */
export interface PersistedKnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  name: string;
  mediaType: string;
  status: "indexed" | "needs_ocr" | "failed";
  failureReason?: string;
  createdAt: string;
}

/** 知识库结构化状态仓库。 */
export interface KnowledgeRepository {
  listBases(): Promise<KnowledgeBaseDocument[]>;
  createBase(input: CreateKnowledgeBaseInput): Promise<KnowledgeBaseDocument>;
  createBaseWithBindings(input: CreateKnowledgeBaseInput, agentIds: string[]): Promise<KnowledgeBaseDocument>;
  getBase(id: string): Promise<KnowledgeBaseDocument | undefined>;
  updateBase(id: string, input: UpdateKnowledgeBaseInput): Promise<KnowledgeBaseDocument | undefined>;
  updateBaseWithBindings(id: string, input: UpdateKnowledgeBaseInput, agentIds?: string[]): Promise<KnowledgeBaseDocument | undefined>;
  removeBase(id: string): Promise<boolean>;
  listBindings(): Promise<KnowledgeBaseBinding[]>;
  replaceBindings(id: string, agentIds: string[]): Promise<void>;
  listBaseIdsForAgent(agentId: string): Promise<string[]>;
  listDocuments(knowledgeBaseId: string): Promise<PersistedKnowledgeDocument[]>;
  listAllDocuments(): Promise<PersistedKnowledgeDocument[]>;
  insertDocument(document: PersistedKnowledgeDocument): Promise<void>;
  insertDocuments(documents: PersistedKnowledgeDocument[]): Promise<void>;
  removeDocument(knowledgeBaseId: string, documentId: string): Promise<boolean>;
}

interface BaseRow extends Record<string, unknown> { id: string; name: string; description: string; created_at: string; updated_at: string }
interface BindingRow extends Record<string, unknown> { knowledge_base_id: string; agent_id: string }
interface DocumentRow extends Record<string, unknown> { document_json: string }

/** 创建以 SQLite 为单一事实来源的知识元数据仓库。 */
export function createKnowledgeRepository(database: Database): KnowledgeRepository {
  return {
    async listBases() {
      return database.read<BaseRow>("SELECT * FROM knowledge_bases ORDER BY created_at, id").map(toBase);
    },
    async createBase(input) {
      return createBase(database, input, []);
    },
    async createBaseWithBindings(input, agentIds) {
      return createBase(database, input, agentIds);
    },
    async getBase(id) {
      const row = database.readOne<BaseRow>("SELECT * FROM knowledge_bases WHERE id = ?", [id]);
      return row ? toBase(row) : undefined;
    },
    async updateBase(id, input) {
      return updateBase(database, id, input);
    },
    async updateBaseWithBindings(id, input, agentIds) {
      return database.transaction(() => {
        const updated = updateBase(database, id, input);
        if (updated && agentIds !== undefined) replaceBindingRows(database, id, agentIds);
        return updated;
      });
    },
    async removeBase(id) {
      return database.transaction(() => database.write("DELETE FROM knowledge_bases WHERE id = ?", [id]).changes === 1);
    },
    async listBindings() {
      return database.read<BindingRow>("SELECT knowledge_base_id, agent_id FROM knowledge_base_agents ORDER BY knowledge_base_id, agent_id")
        .map((row) => ({ knowledgeBaseId: row.knowledge_base_id, agentId: row.agent_id }));
    },
    async replaceBindings(id, agentIds) {
      database.transaction(() => replaceBindingRows(database, id, agentIds));
    },
    async listBaseIdsForAgent(agentId) {
      return database.read<BindingRow>("SELECT knowledge_base_id, agent_id FROM knowledge_base_agents WHERE agent_id = ? ORDER BY knowledge_base_id", [agentId])
        .map((row) => row.knowledge_base_id);
    },
    async listDocuments(knowledgeBaseId) {
      return database.read<DocumentRow>("SELECT document_json FROM knowledge_documents WHERE knowledge_base_id = ? ORDER BY created_at, id", [knowledgeBaseId]).map(toDocument);
    },
    async listAllDocuments() {
      return database.read<DocumentRow>("SELECT document_json FROM knowledge_documents ORDER BY created_at, id").map(toDocument);
    },
    async insertDocument(document) {
      insertDocument(database, document);
    },
    async insertDocuments(documents) {
      database.transaction(() => documents.forEach((document) => insertDocument(database, document)));
    },
    async removeDocument(knowledgeBaseId, documentId) {
      return database.write("DELETE FROM knowledge_documents WHERE knowledge_base_id = ? AND id = ?", [knowledgeBaseId, documentId]).changes === 1;
    },
  };
}

function createBase(database: Database, input: CreateKnowledgeBaseInput, agentIds: string[]): KnowledgeBaseDocument {
  const name = input.name.trim();
  if (!name) throw new TypeError("知识库名称不能为空");
  const now = new Date().toISOString();
  const base = { id: randomUUID(), name, description: input.description?.trim() ?? "", createdAt: now, updatedAt: now };
  return database.transaction(() => {
    database.write("INSERT INTO knowledge_bases(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [base.id, base.name, base.description, now, now]);
    replaceBindingRows(database, base.id, agentIds);
    return base;
  });
}

function updateBase(database: Database, id: string, input: UpdateKnowledgeBaseInput): KnowledgeBaseDocument | undefined {
  const row = database.readOne<BaseRow>("SELECT * FROM knowledge_bases WHERE id = ?", [id]);
  if (!row) return undefined;
  const current = toBase(row);
  const name = input.name === undefined ? current.name : input.name.trim();
  if (!name) throw new TypeError("知识库名称不能为空");
  const updated = { ...current, name, description: input.description === undefined ? current.description : input.description.trim(), updatedAt: new Date().toISOString() };
  database.write("UPDATE knowledge_bases SET name = ?, description = ?, updated_at = ? WHERE id = ?", [updated.name, updated.description, updated.updatedAt, id]);
  return updated;
}

function replaceBindingRows(database: Database, id: string, agentIds: string[]): void {
  database.write("DELETE FROM knowledge_base_agents WHERE knowledge_base_id = ?", [id]);
  for (const agentId of [...new Set(agentIds.map((value) => value.trim()).filter(Boolean))].sort()) {
    database.write("INSERT INTO knowledge_base_agents(knowledge_base_id, agent_id) VALUES (?, ?)", [id, agentId]);
  }
}

function insertDocument(database: Database, document: PersistedKnowledgeDocument): void {
  database.write(
    "INSERT INTO knowledge_documents(id, knowledge_base_id, document_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [document.id, document.knowledgeBaseId, JSON.stringify(document), document.createdAt, document.createdAt],
  );
}

function toBase(row: BaseRow): KnowledgeBaseDocument {
  return { id: row.id, name: row.name, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toDocument(row: DocumentRow): PersistedKnowledgeDocument {
  return JSON.parse(row.document_json) as PersistedKnowledgeDocument;
}
