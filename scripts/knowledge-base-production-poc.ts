import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataPaths } from "../src/server/paths";
import { createKnowledgeBaseService } from "../src/server/knowledge-base/knowledge-base-service";
import { createKnowledgeBaseStore } from "../src/server/knowledge-base/knowledge-base-store";
import { createDeleteKnowledgeBaseTool, createGetKnowledgeDocumentTool, createKnowledgeBaseTool, createListKnowledgeBasesTool, createSearchKnowledgeTool } from "../src/server/knowledge-base/knowledge-tools";

/**
 * 在生产镜像内执行独立临时目录的知识库端到端验证。
 *
 * 此脚本不会读取或修改 /data 中的用户业务数据。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-knowledge-poc-"));
  try {
    const paths = await createDataPaths(root);
    const service = createKnowledgeBaseService({
      paths,
      store: createKnowledgeBaseStore(paths),
      agentExists: async (agentId) => agentId === "production-poc-agent",
    });
    const base = await service.createBase({ name: "生产验证知识库", agentIds: ["production-poc-agent"] });
    const [document] = await service.uploadDocuments(base.id, [{
      name: "验证资料.txt",
      mediaType: "text/plain",
      content: Buffer.from("LanceDB 关键词检索在生产镜像中可用", "utf8"),
    }]);
    if (document.status !== "indexed") throw new Error("生产验证资料未建立索引");
    const hits = await service.searchForAgent("production-poc-agent", { query: "关键词检索" });
    if (!hits.data.results.some((hit) => hit.document.id === document.id)) throw new Error("生产验证未检索到资料");
    const details = await service.readForAgent("production-poc-agent", {
      mode: "document",
      documentId: document.id,
    });
    if (!details.data.content.includes("LanceDB")) throw new Error("生产验证未读取到资料正文");
    const searchTool = createSearchKnowledgeTool("production-poc-agent", service);
    const documentTool = createGetKnowledgeDocumentTool("production-poc-agent", service);
    const listTool = createListKnowledgeBasesTool("production-poc-agent", service);
    const createTool = createKnowledgeBaseTool("production-poc-agent", service);
    const deleteTool = createDeleteKnowledgeBaseTool("production-poc-agent", service);
    const toolSearch = await searchTool.execute("production-poc-search", { query: "关键词检索" }, undefined, undefined, {} as never);
    const toolDocument = await documentTool.execute("production-poc-document", { documentId: document.id }, undefined, undefined, {} as never);
    const toolList = await listTool.execute("production-poc-list", {}, undefined, undefined, {} as never);
    const toolCreate = await createTool.execute("production-poc-create", { name: "工具创建知识库" }, undefined, undefined, {} as never);
    const createdId = JSON.parse(toolCreate.content[0]?.text ?? "{}").id as string | undefined;
    if (!createdId) throw new Error("生产验证创建工具未返回知识库 ID");
    const toolDelete = await deleteTool.execute("production-poc-delete", { knowledgeBaseId: createdId }, undefined, undefined, {} as never);
    if (!toolSearch.content[0]?.text.includes(document.id) || !toolDocument.content[0]?.text.includes(document.id) || !toolList.content[0]?.text.includes(base.id) || !toolDelete.content[0]?.text.includes("deleted")) {
      throw new Error("生产验证 Pi 工具未返回预期资料");
    }
    process.stdout.write("知识库生产镜像 POC 通过\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "知识库生产验证失败"}\n`);
  process.exitCode = 1;
});
