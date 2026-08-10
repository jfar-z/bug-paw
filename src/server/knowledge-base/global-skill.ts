import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const knowledgeBaseSkill = `---
name: knowledge-base
description: 管理并检索当前 Agent 已绑定的知识库资料。
---

# 知识库

使用 \`manage_knowledge_base\` 管理当前 Agent 已绑定的知识库和资料；使用 \`search_knowledge\` 检索资料；使用 \`get_knowledge_document\` 查看指定资料的详情。所有工具均已按当前 Agent 的绑定关系做权限限制，不得推测或尝试访问其他 Agent 的资料。

## 操作原则

- 当回答依赖资料事实时，先用 \`search_knowledge\` 搜索关键词；需要更完整上下文时，再用 \`get_knowledge_document\` 读取命中的 \`documentId\`。
- 使用 \`manage_knowledge_base\` 的 \`action=list\` 列出已绑定知识库；\`action=create\` 创建并自动绑定当前 Agent；\`action=modify_knowladge_base\` 修改名称或说明；\`action=upload_documents\` 导入当前 Agent 工作区内的资料；\`action=delete_document\` 删除单份资料。
- 删除前必须先使用 \`action=list\` 确认 \`knowledgeBaseId\`。\`action=delete_base\` 是全局删除，会清理全部资料、索引和全部 Agent 绑定，不能作为解绑使用。
- 导入资料时只传当前 Agent 工作区的相对文件路径；工具支持 TXT、Markdown、PDF 与 DOCX，单个文件不能超过 20 MB。
- 先使用具体关键词；无结果时可换同义词或缩短检索词。可传 \`knowledgeBaseId\` 缩小检索范围。
- 引用资料时说明资料名称和依据，但不要声称没有检索到的内容。
- 标记为需要 OCR 的扫描 PDF 在本期没有可检索正文；请如实说明这一限制。
`;

/** 安装供所有 Pi 会话发现的知识库检索说明 Skill。 */
export async function ensureKnowledgeBaseSkill(agentDir: string): Promise<void> {
  const directory = join(agentDir, "skills", "knowledge-base");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "SKILL.md"), knowledgeBaseSkill, { encoding: "utf8", mode: 0o600 });
}
