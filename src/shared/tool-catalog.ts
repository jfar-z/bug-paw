/**
 * Agent 可授权工具的稳定目录。
 *
 * 内置和系统工具在前后端共用，扩展工具由资源加载器动态补充。
 */
export interface ToolCatalogItem {
  name: string;
  description: string;
  source: "builtin" | "system" | "capability";
  highRisk: boolean;
}

/** 内置文件与命令工具。 */
export const BUILTIN_TOOL_CATALOG: ToolCatalogItem[] = [
  { name: "read", description: "读取工作目录中的文件", source: "builtin", highRisk: false },
  { name: "bash", description: "在工作目录中执行命令", source: "builtin", highRisk: true },
  { name: "edit", description: "编辑已有文件", source: "builtin", highRisk: true },
  { name: "write", description: "创建或覆盖文件", source: "builtin", highRisk: true },
  { name: "grep", description: "按内容搜索文件", source: "builtin", highRisk: false },
  { name: "find", description: "按路径查找文件", source: "builtin", highRisk: false },
  { name: "ls", description: "列出目录内容", source: "builtin", highRisk: false },
];

/** Web 系统注入、但同样必须获得 Agent 授权的工具。 */
export const SYSTEM_TOOL_CATALOG: ToolCatalogItem[] = [
  { name: "search_knowledge", description: "检索当前 Agent 可访问的知识库", source: "system", highRisk: false },
  { name: "get_knowledge_document", description: "读取知识库文档内容", source: "system", highRisk: false },
  { name: "manage_knowledge_base", description: "管理 Agent 的知识库与资料", source: "system", highRisk: true },
  { name: "scheduled_tasks", description: "创建、修改和执行定时任务", source: "system", highRisk: true },
  { name: "edit_own_prompts", description: "编辑自身的角色、行为风格、规则、用户和初始化提示词", source: "system", highRisk: true },
];

/** 由能力扩展模块提供、可按全局开关停用的工具。 */
export const CAPABILITY_TOOL_CATALOG: ToolCatalogItem[] = [
  { name: "web_search", description: "搜索互联网并返回可引用来源", source: "capability", highRisk: false },
  { name: "web_open", description: "读取公开网页正文", source: "capability", highRisk: false },
];

/** 新建 Agent 的默认权限，保持现有开箱即用的能力。 */
export const DEFAULT_AGENT_TOOL_NAMES = [...BUILTIN_TOOL_CATALOG, ...SYSTEM_TOOL_CATALOG, ...CAPABILITY_TOOL_CATALOG].map(({ name }) => name);

/**
 * 历史 Agent 升级时需要补齐的系统工具权限。
 *
 * edit_own_prompts 为用户可选的权限，仅在新建 Agent 默认启用，不能在启动时强制回写给存量 Agent。
 */
export const SYSTEM_TOOL_NAMES = SYSTEM_TOOL_CATALOG
  .filter(({ name }) => name !== "edit_own_prompts")
  .map(({ name }) => name);
