import type { AgentProfileDocument, CreateAgentInput, UpdateAgentInput } from "../shared/agent-contracts";
import type { CredentialStatus, ModelConfigDocument, ScopedConfigDocument, WebPiSettings } from "../shared/configuration-contracts";
import type { ChatRunSummary, ComposerCatalog, WorkspaceEntry, WorkspaceFileSummary, WorkspaceTextPreview } from "../shared/contracts";
import type { AgentReference, AgentReferenceInput } from "../shared/agent-reference-contracts";
import type { CreateScheduledTaskInput, ScheduledTask, ScheduledTaskRun, UpdateScheduledTaskInput } from "../shared/scheduled-task-contracts";
import type { SearchProviderConfig, WebResearchConfig, WebResearchSettingsDocument } from "../shared/web-research-contracts";
import type { TtsProfileInput, TtsSettingsDocument } from "../shared/tts-contracts";
import type { EmbeddingConfigInput, EmbeddingSettingsDocument } from "../shared/knowledge-retrieval-contracts";
import type { SessionBulkAction, SessionBulkPreview, SessionBulkResult, SessionBulkTarget } from "../shared/session-bulk-contracts";

export type { ScheduledTask, ScheduledTaskRun, SessionBulkAction, SessionBulkPreview, SessionBulkResult, SessionBulkTarget };

export interface ServiceStatus {
  initialized: boolean;
  authenticated: boolean;
}

export interface SetupRequest {
  password: string;
  confirmPassword: string;
  provider: {
    type: string;
    apiKey: string;
    baseUrl?: string;
    defaultModel: string;
  };
}

export interface SetupResponse {
  initialized: true;
}

export interface UserProfile {
  displayName: string;
  avatar?: { kind: "image"; revision: string; mediaType: "image/png" | "image/jpeg" | "image/webp" };
}

export interface UserProfileDocument {
  revision: string;
  profile: UserProfile;
}

/** 搜索凭证写入后返回的脱敏状态。 */
export interface CredentialWriteResponse {
  credentialRevision: string;
  status: { providerId: string; type: "api_key"; configured: true } | null;
}

export interface ModelSummary {
  provider: string;
  id: string;
  name: string;
}

export interface SessionSummary {
  id: string;
  agentId?: string;
  name?: string;
  firstMessage: string;
  modified: string;
  messageCount: number;
  scheduledTaskCount?: number;
}

export interface SessionSnapshot {
  id: string;
  agentId?: string;
  messages: unknown[];
  model?: ModelSummary;
  run?: ChatRunSummary;
  lastEventId: number;
}

export interface SessionEditDraft { text: string; filePaths: string[]; references: AgentReference[]; missingFilePaths: string[] }

export interface ProvidersDocument extends ModelConfigDocument {
  credentials: CredentialStatus[];
  credentialRevision: string;
}

export type ModelConnectionTestRequest =
  | { scope: "current"; modelId: string }
  | { scope: "all" };

export interface ModelConnectionTestItem {
  modelId: string;
  modelName: string;
  ok: boolean;
  durationMs: number;
  responsePreview?: string;
  errorCode?: string;
  message?: string;
}

export interface ModelConnectionTestResult {
  providerId: string;
  results: ModelConnectionTestItem[];
}

export interface DiscoveredModel {
  id: string;
  name: string;
  exists: boolean;
}

export interface DiscoverModelsResult {
  providerId: string;
  models: DiscoveredModel[];
}

export interface ResourceCatalogItem { id: string; type: "skill" | "prompt" | "extension" | "theme"; name: string; description: string; path: string; source: string; scope: "global" | "agent"; origin: "package" | "top-level"; enabled: boolean; inherited: boolean }
export interface ResourceCatalog { resources: ResourceCatalogItem[]; tools: Array<{ name: string; description: string; extensionPath: string; highRisk: boolean }>; diagnostics: Array<{ type: string; message: string; path?: string }>; packages?: Array<{ source: string; scope: "user" | "project"; filtered: boolean; installedPath?: string }> }
export type AgentPromptFile = "role" | "behavior" | "rules" | "user" | "bootsharp";
export interface DiagnosticsReport { generatedAt: string; version: { app: string; node: string; pi: string }; mounts: Array<{ source: string; target: string; writable: boolean }>; diagnostics: Array<{ source: string; severity: "info" | "warning" | "error"; code: string; message: string; field?: string }>; backgroundErrors?: { total: number; latestCode?: string; latestAt?: string }; operational?: { database: { quickCheck: string; journalMode: string }; runtime: { activeLeases: number; trackedAgents: number }; limits: Record<string, number> } }
export interface ConfigurationHistoryEntry { id: string; createdAt: string; scope: "global" | "agent" | "credential" | "resource"; targetId?: string; summary: string; outcome: "success" | "failed"; restorable?: boolean }
export interface ConfigurationImportPreview { previewId: string; added: string[]; changed: string[]; conflicts: string[]; invalid: Array<{ file: string; message: string }> }
export interface KnowledgeDocumentSummary { id: string; knowledgeBaseId: string; name: string; mediaType: string; status: "indexed" | "needs_ocr" | "failed"; failureReason?: string; createdAt: string; text?: string; textTruncated?: boolean }
/** 管理端查看的一段已建立索引的知识库文本。 */
export interface KnowledgeDocumentChunk { chunkId: string; documentId: string; index: number; text: string; page?: number }
export interface KnowledgeBaseDetail { id: string; name: string; description: string; createdAt: string; updatedAt: string; agentIds: string[]; documents: KnowledgeDocumentSummary[] }
export interface KnowledgeSearchResult { chunkId: string; documentId: string; index: number; text: string; page?: number; score?: number }

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** 将应用内部 API 资源路径映射到当前稳定版本。 */
export function apiV1Url(url: string): string {
  return url.startsWith("/api/") && !url.startsWith("/api/v1/")
    ? `/api/v1/${url.slice("/api/".length)}`
    : url;
}

/**
 * 对 fetch 做统一 JSON 和错误协议处理。
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const hasJsonBody = init?.body !== undefined && !(init.body instanceof FormData);
  const response = await fetch(apiV1Url(url), {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 204) {
    return undefined as T;
  }
  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = responseText ? JSON.parse(responseText) as unknown : undefined;
  } catch {
    throw new ApiClientError(
      "API_RESPONSE_INVALID",
      "服务响应格式无效",
      response.status,
      response.headers.get("X-Request-Id") ?? undefined,
    );
  }
  if (!response.ok) {
    const error = readApiError(payload);
    throw new ApiClientError(
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? "请求失败",
      response.status,
      error?.requestId ?? response.headers.get("X-Request-Id") ?? undefined,
      error?.details,
    );
  }
  return payload as T;
}

/**
 * 将 cwd 相对路径转换为经过逐段编码的文件接口地址。
 */
export function workspaceFileUrl(agentId: string, path: string, download = false): string {
  const encodedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const base = apiV1Url(`/api/agents/${encodeURIComponent(agentId)}/files/${encodedPath}`);
  return download ? `${base}?download=1` : base;
}

/**
 * 读取工作目录文件的实时元数据，避免在会话中持久化易过期的信息。
 */
async function getWorkspaceFile(agentId: string, path: string): Promise<WorkspaceFileSummary> {
  const response = await fetch(workspaceFileUrl(agentId, path), {
    method: "HEAD",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new ApiClientError("FILE_NOT_FOUND", "工作目录文件不存在或不可读取", response.status);
  }
  const name = path.split("/").at(-1) || path;
  return {
    path,
    name,
    mediaType: response.headers.get("Content-Type")?.split(";", 1)[0] || "application/octet-stream",
    size: Number(response.headers.get("Content-Length") ?? 0),
    modifiedAt: response.headers.get("Last-Modified") ?? "",
  };
}

async function synthesizeAgentSpeech(agentId: string, input: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(apiV1Url(`/api/agents/${encodeURIComponent(agentId)}/tts`), {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!response.ok) throw new ApiClientError("TTS_REQUEST_FAILED", "语音合成服务暂时不可用", response.status);
  return response;
}

function readApiError(payload: unknown): {
  code?: string;
  message?: string;
  requestId?: string;
  details?: Record<string, unknown>;
} | undefined {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return undefined;
  }
  const error = payload.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
    ...(isRecord(record.details) ? { details: record.details } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const api = {
  getKnowledgeRetrieval: () => request<EmbeddingSettingsDocument>("/api/capabilities/knowledge-retrieval"),
  updateKnowledgeRetrieval: (revision: string, config: EmbeddingConfigInput) => request<EmbeddingSettingsDocument>("/api/capabilities/knowledge-retrieval", { method: "PATCH", body: JSON.stringify({ revision, config }) }),
  getKnowledgeRetrievalCredential: () => request<{ apiKey: string }>("/api/capabilities/knowledge-retrieval/credential"),
  rebuildKnowledgeRetrieval: () => request<{ totalBases: number; rebuiltBases: number; failedBases: string[] }>("/api/capabilities/knowledge-retrieval/rebuild", { method: "POST" }),
  getTtsProfiles: () => request<TtsSettingsDocument>("/api/capabilities/tts"),
  getTtsProfileCredential: (profileId: string) => request<{ apiKey: string }>(`/api/capabilities/tts/${encodeURIComponent(profileId)}/credential`),
  createTtsProfile: (input: TtsProfileInput) => request<{ revision: string }>("/api/capabilities/tts", { method: "POST", body: JSON.stringify(input) }),
  updateTtsProfile: (id: string, revision: string, input: TtsProfileInput) => request<{ revision: string }>(`/api/capabilities/tts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ revision, ...input }) }),
  deleteTtsProfile: (id: string, revision: string) => request<void>(`/api/capabilities/tts/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ revision }) }),
  getWebResearch: () => request<WebResearchSettingsDocument>("/api/capabilities/web-research"),
  updateWebResearch: (revision: string, config: WebResearchConfig) => request<WebResearchSettingsDocument>("/api/capabilities/web-research", { method: "PATCH", body: JSON.stringify({ revision, config }) }),
  addWebResearchProvider: (revision: string, provider: SearchProviderConfig) => request<WebResearchSettingsDocument>("/api/capabilities/web-research/providers", { method: "POST", body: JSON.stringify({ revision, provider }) }),
  deleteWebResearchProvider: (providerId: string, configRevision: string, credentialRevision: string) => request<void>(`/api/capabilities/web-research/providers/${encodeURIComponent(providerId)}`, { method: "DELETE", body: JSON.stringify({ configRevision, credentialRevision }) }),
  testWebResearchProvider: (providerId: string) => request<{ ok: boolean; message: string }>(`/api/capabilities/web-research/providers/${encodeURIComponent(providerId)}/test`, { method: "POST" }),
  getWebResearchProviderCredential: (providerId: string) => request<{ apiKey: string }>(`/api/capabilities/web-research/providers/${encodeURIComponent(providerId)}/credential`),
  setWebResearchProviderCredential: (providerId: string, revision: string, apiKey: string) => request<CredentialWriteResponse>(`/api/capabilities/web-research/providers/${encodeURIComponent(providerId)}/credential`, { method: "PUT", body: JSON.stringify({ revision, apiKey }) }),
  deleteWebResearchProviderCredential: (providerId: string, revision: string) => request<CredentialWriteResponse>(`/api/capabilities/web-research/providers/${encodeURIComponent(providerId)}/credential`, { method: "DELETE", body: JSON.stringify({ revision }) }),
  getStatus: () => request<ServiceStatus>("/api/status"),
  setup: (input: SetupRequest) =>
    request<SetupResponse>("/api/setup", { method: "POST", body: JSON.stringify(input) }),
  login: (password: string, remember: boolean) =>
    request<{ authenticated: true }>("/api/login", { method: "POST", body: JSON.stringify({ password, remember }) }),
  logout: () => request<void>("/api/logout", { method: "POST" }),
  getProfile: () => request<UserProfileDocument>("/api/profile"),
  updateProfile: (revision: string, displayName: string) =>
    request<UserProfileDocument>("/api/profile", { method: "PATCH", body: JSON.stringify({ revision, displayName }) }),
  uploadProfileAvatar: (revision: string, file: File) => {
    const form = new FormData();
    form.append("avatar", file, file.name);
    return request<UserProfileDocument>(`/api/profile/avatar?revision=${encodeURIComponent(revision)}`, { method: "POST", body: form });
  },
  listAgents: () => request<{ agents: AgentProfileDocument[] }>("/api/agents"),
  reorderAgents: (agentIds: string[]) => request<{ agents: AgentProfileDocument[] }>("/api/agents/order", {
    method: "POST", body: JSON.stringify({ agentIds }),
  }),
  getAgent: (agentId: string) => request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}`),
  getAgentPrompt: (agentId: string, file: AgentPromptFile) => request<{ file: AgentPromptFile; content: string }>(`/api/agents/${encodeURIComponent(agentId)}/prompts/${file}`),
  replaceAgentPrompt: (agentId: string, file: AgentPromptFile, content: string) => request<{ file: AgentPromptFile; content: string }>(`/api/agents/${encodeURIComponent(agentId)}/prompts/${file}`, {
    method: "PUT", body: JSON.stringify({ content }),
  }),
  createAgent: (input: CreateAgentInput) => request<AgentProfileDocument>("/api/agents", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  updateAgent: (agentId: string, revision: string, patch: UpdateAgentInput) =>
    request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ revision, ...patch }),
    }),
  archiveAgent: (agentId: string, revision: string) =>
    request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}/archive`, {
      method: "POST", body: JSON.stringify({ revision }),
    }),
  restoreAgent: (agentId: string, revision: string) =>
    request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}/archive`, {
      method: "DELETE", body: JSON.stringify({ revision }),
    }),
  cloneAgent: (agentId: string, name?: string, copyWorkspace = false) =>
    request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}/clone`, {
      method: "POST", body: JSON.stringify({ name, copyWorkspace }),
    }),
  getAgentDeletePreview: (agentId: string) => request<{
    agentId: string; name: string; sessions: { count: number }; workspace: { files: number; bytes: number };
  }>(`/api/agents/${encodeURIComponent(agentId)}/delete-preview`),
  deleteAgent: (agentId: string, removeSessions: boolean, removeWorkspace: boolean) =>
    request<{ trashPath?: string }>(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE", body: JSON.stringify({ removeSessions, removeWorkspace }),
    }),
  uploadAgentAvatar: (agentId: string, revision: string, file: File) => {
    const form = new FormData();
    form.append("avatar", file, file.name);
    return request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}/avatar?revision=${encodeURIComponent(revision)}`, {
      method: "POST",
      body: form,
    });
  },
  listProviders: () => request<ProvidersDocument>("/api/providers"),
  createProvider: (providerId: string, revision: string, provider: Record<string, unknown>) =>
    request<ModelConfigDocument>("/api/providers", {
      method: "POST", body: JSON.stringify({ id: providerId, revision, provider }),
    }),
  saveProvider: (providerId: string, revision: string, provider: Record<string, unknown>) =>
    request<ModelConfigDocument>(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: "PUT", body: JSON.stringify({ revision, provider }),
    }),
  renameProvider: (providerId: string, targetId: string, revision: string) =>
    request<ModelConfigDocument>(`/api/providers/${encodeURIComponent(providerId)}/rename`, {
      method: "POST", body: JSON.stringify({ id: targetId, revision, confirmed: true }),
    }),
  reorderProviders: (providerIds: string[], revision: string) =>
    request<ModelConfigDocument>("/api/providers/order", {
      method: "POST", body: JSON.stringify({ providerIds, revision }),
    }),
  reorderProviderModels: (providerId: string, modelIds: string[], revision: string) =>
    request<ModelConfigDocument>(`/api/providers/${encodeURIComponent(providerId)}/models/order`, {
      method: "POST", body: JSON.stringify({ modelIds, revision }),
    }),
  removeProvider: (providerId: string, revision: string) =>
    request<ModelConfigDocument>(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE", body: JSON.stringify({ revision }),
    }),
  removeProviderModel: (providerId: string, modelId: string, revision: string) =>
    request<ModelConfigDocument>(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
      method: "DELETE", body: JSON.stringify({ revision }),
    }),
  saveProviderCredential: (providerId: string, revision: string, apiKey: string) =>
    request<{ credentialRevision: string; status: CredentialStatus }>(`/api/providers/${encodeURIComponent(providerId)}/credential`, {
      method: "PUT", body: JSON.stringify({ revision, apiKey }),
    }),
  getProviderCredential: (providerId: string) =>
    request<{ apiKey: string }>(`/api/providers/${encodeURIComponent(providerId)}/credential`),
  removeProviderCredential: (providerId: string, revision: string) =>
    request<{ credentialRevision: string; status: null }>(`/api/providers/${encodeURIComponent(providerId)}/credential`, {
      method: "DELETE", body: JSON.stringify({ revision }),
    }),
  testProvider: (providerId: string, test: ModelConnectionTestRequest) =>
    request<ModelConnectionTestResult>(`/api/providers/${encodeURIComponent(providerId)}/test`, {
      method: "POST", body: JSON.stringify(test),
    }),
  discoverProviderModels: (providerId: string) =>
    request<DiscoverModelsResult>(`/api/providers/${encodeURIComponent(providerId)}/discover-models`, { method: "POST" }),
  getGlobalSettings: () => request<ScopedConfigDocument<WebPiSettings>>("/api/configuration/global"),
  updateGlobalSettings: (revision: string, set: Record<string, unknown>, inherit: string[] = []) =>
    request<ScopedConfigDocument<WebPiSettings>>("/api/configuration/global", { method: "PATCH", body: JSON.stringify({ revision, set, inherit }) }),
  getAgentSettings: (agentId: string) => request<ScopedConfigDocument<WebPiSettings>>(`/api/agents/${encodeURIComponent(agentId)}/settings`),
  updateAgentSettings: (agentId: string, revision: string, set: Record<string, unknown>, inherit: string[]) =>
    request<ScopedConfigDocument<WebPiSettings>>(`/api/agents/${encodeURIComponent(agentId)}/settings`, { method: "PATCH", body: JSON.stringify({ revision, set, inherit }) }),
  listResources: (agentId?: string) => request<ResourceCatalog>(`/api/resources${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`),
  getResourceContent: (resourceId: string, agentId?: string) => request<{ content: string }>(`/api/resources/content?id=${encodeURIComponent(resourceId)}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}`),
  setResourceMode: (resourceId: string, mode: "enabled" | "disabled" | "inherit", target: "global" | "agent", agentId?: string) => request<ResourceCatalog>(`/api/resources/${encodeURIComponent(resourceId)}`, { method: "PATCH", body: JSON.stringify({ mode, target, agentId }) }),
  installResource: (source: string, scope: "global" | "agent", agentId?: string) => request<{ taskId: string }>("/api/resources/install", { method: "POST", body: JSON.stringify({ source, scope, agentId, confirmed: true }) }),
  removeResourcePackage: (source: string, scope: "global" | "agent", agentId?: string) => request<{ taskId: string }>("/api/resources/remove", { method: "POST", body: JSON.stringify({ source, scope, agentId, confirmed: true }) }),
  getDiagnostics: () => request<DiagnosticsReport>("/api/configuration/diagnostics"),
  refreshPiRuntime: () => request<{ abortedSessions: number }>("/api/configuration/refresh-runtime", { method: "POST" }),
  previewConfigurationImport: (value: unknown) => request<ConfigurationImportPreview>("/api/configuration/import/preview", { method: "POST", body: JSON.stringify(value) }),
  applyConfigurationImport: (previewId: string) => request<{ applied: true }>("/api/configuration/import/apply", { method: "POST", body: JSON.stringify({ previewId, confirmed: true }) }),
  listConfigurationHistory: () => request<{ entries: ConfigurationHistoryEntry[] }>("/api/configuration/history"),
  restoreConfigurationHistory: (id: string, revision: string) => request<ScopedConfigDocument<WebPiSettings>>(`/api/configuration/history/${encodeURIComponent(id)}/restore`, { method: "POST", body: JSON.stringify({ revision }) }),
  listModels: () => request<{ models: ModelSummary[] }>("/api/models"),
  listScheduledTasks: (agentId: string) => request<{ tasks: ScheduledTask[] }>(`/api/agents/${encodeURIComponent(agentId)}/scheduled-tasks`),
  createScheduledTask: (agentId: string, input: Omit<CreateScheduledTaskInput, "agentId">) => request<ScheduledTask>(`/api/agents/${encodeURIComponent(agentId)}/scheduled-tasks`, { method: "POST", body: JSON.stringify(input) }),
  updateScheduledTask: (taskId: string, input: UpdateScheduledTaskInput) => request<ScheduledTask>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteScheduledTask: (taskId: string) => request<void>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" }),
  runScheduledTask: (taskId: string) => request<ScheduledTaskRun>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" }),
  listScheduledTaskRuns: (taskId: string) => request<{ runs: ScheduledTaskRun[] }>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs`),
  getScheduledTaskTimezones: () => request<{ serverTimeZone: string; timezones: string[] }>("/api/scheduled-tasks/timezones"),
  listSessions: (agentId: string, archived = false) => request<{ sessions: SessionSummary[] }>(
    `/api/sessions?agentId=${encodeURIComponent(agentId)}${archived ? "&archived=true" : ""}`,
  ),
  previewSessionBulk: (action: SessionBulkAction, target: SessionBulkTarget) => request<SessionBulkPreview>("/api/sessions/bulk/preview", {
    method: "POST",
    body: JSON.stringify({ action, target }),
  }),
  executeSessionBulk: (action: SessionBulkAction, target: SessionBulkTarget, fingerprint: string) => request<SessionBulkResult>("/api/sessions/bulk", {
    method: "POST",
    body: JSON.stringify({ action, target, fingerprint }),
  }),
  createSession: (agentId: string) => request<SessionSnapshot>("/api/sessions", { method: "POST", body: JSON.stringify({ agentId }) }),
  openSession: (sessionId: string, signal?: AbortSignal) => request<SessionSnapshot>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    { signal },
  ),
  sendMessage: (sessionId: string, text: string, filePaths: string[] = [], references: AgentReferenceInput[] = []) =>
    request<ChatRunSummary>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, filePaths, references }),
    }),
  sendBranchMessage: (sessionId: string, entryId: string, text: string, filePaths: string[] = [], references: AgentReferenceInput[] = []) =>
    request<{ snapshot: SessionSnapshot; run: ChatRunSummary }>(`/api/sessions/${encodeURIComponent(sessionId)}/branches/${encodeURIComponent(entryId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, filePaths, references }),
    }),
  editSessionBranch: (sessionId: string, entryId: string) => request<{ snapshot: SessionSnapshot; draft: SessionEditDraft }>(`/api/sessions/${encodeURIComponent(sessionId)}/branches/${encodeURIComponent(entryId)}/edit`, { method: "POST" }),
  navigateSessionBranch: (sessionId: string, entryId: string) => request<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/branches/${encodeURIComponent(entryId)}/navigate`, { method: "POST" }),
  regenerateSessionBranch: (sessionId: string, entryId: string) => request<{ snapshot: SessionSnapshot; run: ChatRunSummary }>(`/api/sessions/${encodeURIComponent(sessionId)}/branches/${encodeURIComponent(entryId)}/regenerate`, { method: "POST" }),
  getComposerCatalog: (agentId: string) => request<ComposerCatalog>(`/api/agents/${encodeURIComponent(agentId)}/composer-catalog`),
  uploadAttachments: (agentId: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name));
    return request<{ files: WorkspaceFileSummary[] }>(`/api/agents/${encodeURIComponent(agentId)}/attachments`, {
      method: "POST",
      body: form,
    });
  },
  listKnowledgeBases: () => request<{ knowledgeBases: KnowledgeBaseDetail[] }>("/api/knowledge-bases"),
  getKnowledgeBase: (knowledgeBaseId: string) => request<KnowledgeBaseDetail>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`),
  createKnowledgeBase: (input: { name: string; description?: string; agentIds?: string[] }) => request<KnowledgeBaseDetail>("/api/knowledge-bases", { method: "POST", body: JSON.stringify(input) }),
  updateKnowledgeBase: (knowledgeBaseId: string, input: { name?: string; description?: string; agentIds?: string[] }) => request<KnowledgeBaseDetail>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteKnowledgeBase: (knowledgeBaseId: string) => request<void>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`, { method: "DELETE" }),
  uploadKnowledgeDocuments: (knowledgeBaseId: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name));
    return request<{ documents: KnowledgeDocumentSummary[] }>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`, { method: "POST", body: form });
  },
  getKnowledgeDocument: (knowledgeBaseId: string, documentId: string) => request<KnowledgeDocumentSummary>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`),
  listKnowledgeDocumentChunks: (knowledgeBaseId: string, documentId: string) => request<{ chunks: KnowledgeDocumentChunk[] }>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/chunks`),
  knowledgeDocumentSourceUrl: (knowledgeBaseId: string, documentId: string) => apiV1Url(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/source`),
  deleteKnowledgeDocument: (knowledgeBaseId: string, documentId: string) => request<void>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }),
  searchKnowledgeBase: (knowledgeBaseId: string, query: string) => request<{ results: KnowledgeSearchResult[] }>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/search`, { method: "POST", body: JSON.stringify({ query }) }),
  listWorkspaceEntries: (agentId: string, directory = "", includeHidden = false) => request<{ entries: WorkspaceEntry[] }>(`/api/agents/${encodeURIComponent(agentId)}/workspace/entries?directory=${encodeURIComponent(directory)}${includeHidden ? "&includeHidden=true" : ""}`),
  searchWorkspaceEntries: (agentId: string, query: string, includeHidden = false) => request<{ entries: WorkspaceEntry[] }>(`/api/agents/${encodeURIComponent(agentId)}/workspace/search?query=${encodeURIComponent(query)}${includeHidden ? "&includeHidden=true" : ""}`),
  getWorkspaceText: (agentId: string, path: string) => request<WorkspaceTextPreview>(`/api/agents/${encodeURIComponent(agentId)}/workspace/text?path=${encodeURIComponent(path)}`),
  uploadWorkspaceFiles: (agentId: string, directory: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name));
    return request<{ entries: WorkspaceEntry[] }>(`/api/agents/${encodeURIComponent(agentId)}/workspace/uploads?directory=${encodeURIComponent(directory)}`, { method: "POST", body: form });
  },
  createWorkspaceDirectory: (agentId: string, directory: string, name: string) => request<WorkspaceEntry>(`/api/agents/${encodeURIComponent(agentId)}/workspace/directories`, { method: "POST", body: JSON.stringify({ directory, name }) }),
  updateWorkspaceEntry: (agentId: string, body: { operation: "rename"; path: string; name: string } | { operation: "move"; path: string; targetDirectory: string; createTargetDirectory?: boolean }) => request<WorkspaceEntry>(`/api/agents/${encodeURIComponent(agentId)}/workspace/entries`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteWorkspaceEntries: (agentId: string, paths: string[]) => request<void>(`/api/agents/${encodeURIComponent(agentId)}/workspace/entries`, { method: "DELETE", body: JSON.stringify({ paths }) }),
  getWorkspaceFile,
  synthesizeAgentSpeech,
  abort: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }),
  setModel: (sessionId: string, provider: string, modelId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: "PUT",
      body: JSON.stringify({ provider, modelId }),
    }),
  renameSession: (sessionId: string, name: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  archiveSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" }),
  unarchiveSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "DELETE" }),
  deleteSession: (sessionId: string, confirmBoundTasks = false) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}${confirmBoundTasks ? "?confirmBoundTasks=true" : ""}`, { method: "DELETE" }),
};
