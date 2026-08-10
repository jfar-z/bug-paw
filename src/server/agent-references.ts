import type { AgentReference, AgentReferenceInput } from "../shared/agent-reference-contracts";
import type { WorkspaceEntry } from "../shared/contracts";

/** 当前 Agent 可引用资源的服务端可信目录。 */
export interface AgentReferenceCatalog {
  skills: Array<{ name: string }>;
  knowledgeBases: Array<{ id: string; name: string }>;
  workspaceEntries: WorkspaceEntry[];
}

/** 服务端重建用户引用所需的目录查询能力。 */
export interface AgentReferenceResolver {
  resolve(agentId: string, inputs: AgentReferenceInput[]): Promise<AgentReference[] | undefined>;
}

/**
 * 创建按当前 Agent 重新授权引用的解析器，浏览器提交的显示名称不会被采用。
 */
export function createAgentReferenceResolver(
  loadCatalog: (agentId: string) => Promise<AgentReferenceCatalog>,
): AgentReferenceResolver {
  return {
    async resolve(agentId, inputs) {
      const catalog = await loadCatalog(agentId);
      const references: AgentReference[] = [];
      for (const input of inputs) {
        if (input.type === "skill") {
          const skill = catalog.skills.find((item) => item.name === input.name);
          if (!skill) return undefined;
          references.push({ type: "skill", name: skill.name });
          continue;
        }
        if (input.type === "knowledge") {
          const knowledgeBase = catalog.knowledgeBases.find((item) => item.id === input.id);
          if (!knowledgeBase) return undefined;
          references.push({ type: "knowledge", id: knowledgeBase.id, name: knowledgeBase.name });
          continue;
        }
        const entry = catalog.workspaceEntries.find((item) => item.path === input.path);
        if (!entry) return undefined;
        references.push({ type: "file", path: entry.path, kind: entry.kind, name: entry.name });
      }
      return references;
    },
  };
}

/**
 * 读取浏览器提交的最小引用标识；展示字段不得成为服务端授权依据。
 */
export function readAgentReferenceInputs(value: unknown): AgentReferenceInput[] | "invalid" {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return "invalid";
  const inputs: AgentReferenceInput[] = [];
  const keys = new Set<string>();
  for (const valueItem of value) {
    if (!isRecord(valueItem) || typeof valueItem.type !== "string") return "invalid";
    if (valueItem.type === "skill" && typeof valueItem.name === "string" && valueItem.name) {
      inputs.push({ type: "skill", name: valueItem.name });
    } else if (valueItem.type === "knowledge" && typeof valueItem.id === "string" && valueItem.id) {
      inputs.push({ type: "knowledge", id: valueItem.id });
    } else if (valueItem.type === "file" && typeof valueItem.path === "string" && valueItem.path) {
      inputs.push({ type: "file", path: valueItem.path });
    } else {
      return "invalid";
    }
    const input = inputs.at(-1)!;
    const key = input.type === "skill" ? `skill:${input.name}` : input.type === "knowledge" ? `knowledge:${input.id}` : `file:${input.path}`;
    if (keys.has(key)) return "invalid";
    keys.add(key);
  }
  return inputs;
}

/**
 * 将服务端已授权的引用编译为只传递给 Pi 的统一协议标签。
 */
export function compileAgentReferences(references: AgentReference[]): string {
  return references.map((reference) => {
    if (reference.type === "skill") {
      return `<agent_references version="1" type="skill" name="${escapeXmlAttribute(reference.name)}"/>`;
    }
    if (reference.type === "knowledge") {
      return `<agent_references version="1" type="knowledge" id="${escapeXmlAttribute(reference.id)}" name="${escapeXmlAttribute(reference.name)}"/>`;
    }
    return `<agent_references version="1" type="file" path="${escapeXmlAttribute(reference.path)}" kind="${reference.kind}"/>`;
  }).join("\n");
}

/**
 * 用于 XML 属性值的最小必要转义，防止展示名称改变协议结构。
 */
function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
