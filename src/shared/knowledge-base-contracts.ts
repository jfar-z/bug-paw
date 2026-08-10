/** 知识库的持久化元数据。 */
export interface KnowledgeBaseDocument {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** 知识库与 Agent 的多对多绑定记录。 */
export interface KnowledgeBaseBinding {
  knowledgeBaseId: string;
  agentId: string;
}

/** 创建知识库时可提交的字段。 */
export interface CreateKnowledgeBaseInput {
  name: string;
  description?: string;
}

/** 更新知识库时可提交的字段。 */
export interface UpdateKnowledgeBaseInput {
  name?: string;
  description?: string;
}
