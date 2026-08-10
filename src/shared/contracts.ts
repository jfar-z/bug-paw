export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface WorkspaceFileRef {
  path: string;
}

/**
 * 浏览器可见的工作目录文件信息，不包含容器内绝对路径。
 */
export interface WorkspaceFileSummary extends WorkspaceFileRef {
  name: string;
  mediaType: string;
  size: number;
  modifiedAt: string;
}

/**
 * Agent 工作目录中可供浏览的文件或目录项，不包含容器绝对路径。
 */
export interface WorkspaceEntry extends WorkspaceFileRef {
  name: string;
  kind: "file" | "directory";
  size?: number;
  mediaType?: string;
  modifiedAt: string;
}

/** 输入框一次性缓存的当前 Agent 可引用资源与安全命令目录。 */
export interface ComposerCatalog {
  skills: Array<{ name: string; description: string }>;
  commands: Array<{ name: string; description?: string; source: "extension" | "prompt" | "skill" }>;
  knowledgeBases: Array<{ id: string; name: string }>;
  workspaceEntries: WorkspaceEntry[];
}

/**
 * 受大小限制的文本文件预览内容。
 */
export interface WorkspaceTextPreview {
  path: string;
  content: string;
  truncated: boolean;
}

export interface PublicProviderConfig {
  type: string;
  baseUrl?: string;
  defaultModel: string;
  hasApiKey: boolean;
}

export interface PublicAppConfig {
  initialized: boolean;
  provider?: PublicProviderConfig;
}

export type ChatRunStatus = "queued" | "running" | "completed" | "aborted" | "error" | "interrupted";

export interface ChatRunSummary {
  runId: string;
  sessionId: string;
  status: ChatRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/**
 * 带稳定 Agent 归属的会话摘要。
 */
export interface SessionSummary {
  id: string;
  agentId: string;
  name?: string;
  firstMessage: string;
  modified: string;
  messageCount: number;
}
