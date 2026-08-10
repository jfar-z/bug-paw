import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CreateAgentInput, UpdateAgentInput } from "../../shared/agent-contracts";
import type { AgentStore } from "../agents/agent-store";
import { AgentWorkspaceError } from "../agents/agent-workspace";
import { type AgentPromptFile, AgentPromptStore } from "../agents/agent-prompt-store";
import { VersionConflictError } from "../configuration/versioned-json-store";
import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import type { AgentRemovalPermit } from "../core/agent-lifecycle-gate";
import { statusForDomainError } from "../http/error-handler";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface AgentRouteDependencies {
  authService: AuthService;
  store: AgentStore;
  removeAgent?: (agentId: string) => Promise<void>;
  finalizeAgentRemoval?: (agentId: string) => void;
  restoreAgent?: (agentId: string) => void;
  runAgentMutation?<T>(agentId: string, operation: () => Promise<T>): Promise<T>;
  runModelMutation?<T>(operation: () => Promise<T>): Promise<T>;
  beginAgentRemoval?: (agentId: string) => Promise<AgentRemovalPermit>;
  countSessions?: (agentId: string) => Promise<number>;
  prompts?: AgentPromptStore;
  refreshPromptContext?: (agentId: string) => Promise<void>;
  resolveAvailableModel?: (provider: string, modelId: string) => Promise<{
    reasoning: boolean;
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  } | undefined>;
}

type ThinkingLevel = NonNullable<CreateAgentInput["defaultThinkingLevel"]>;

/**
 * 注册 Agent Profile 的查询、生命周期和删除接口。
 */
export function registerAgentRoutes(app: FastifyInstance, dependencies: AgentRouteDependencies): void {
  app.get("/api/agents", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send({ agents: await dependencies.store.list() });
  });

  app.post("/api/agents/order", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (!Array.isArray(body.agentIds) || body.agentIds.some((agentId) => typeof agentId !== "string")) {
      return sendApiError(reply, 400, "INVALID_AGENT_ORDER", "Agent 排序格式无效");
    }
    try {
      return reply.send({ agents: await dependencies.store.reorder(body.agentIds) });
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.post("/api/agents", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.name !== "string" || !body.name.trim()) {
      return sendApiError(reply, 400, "INVALID_AGENT_NAME", "Agent 名称不能为空");
    }
    if (body.instructions !== undefined) {
      return sendApiError(reply, 400, "PROMPT_FILES_ONLY", "提示词请通过独立 Markdown 文件接口保存");
    }
    try {
      const created = await runModelMutation(dependencies, async () => {
        const input = readCreateInput(body);
        await validateModelSelection(input, dependencies);
        return dependencies.store.create(input);
      });
      return reply.code(201).send(created);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      const agent = await dependencies.store.get(request.params.id);
      return agent ? reply.send(agent) : sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.get<{ Params: { id: string; file: string } }>("/api/agents/:id/prompts/:file", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const file = parsePromptFile(request.params.file);
    if (!file) return sendApiError(reply, 400, "INVALID_PROMPT_FILE", "提示词文件无效");
    try {
      if (!(await dependencies.store.get(request.params.id))) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
      return reply.send({ file, content: await dependencies.prompts?.read(request.params.id, file) ?? "" });
    } catch (error) { return sendAgentError(reply, error); }
  });

  app.put<{ Params: { id: string; file: string } }>("/api/agents/:id/prompts/:file", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const file = parsePromptFile(request.params.file);
    const body = isRecord(request.body) ? request.body : {};
    if (!file) return sendApiError(reply, 400, "INVALID_PROMPT_FILE", "提示词文件无效");
    if (typeof body.content !== "string") return sendApiError(reply, 400, "PROMPT_CONTENT_REQUIRED", "提示词内容必须是字符串");
    const content = body.content;
    try {
      if (!(await dependencies.store.get(request.params.id))) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
      if (!dependencies.prompts) throw new Error("提示词存储尚未就绪");
      return await runAgentMutation(dependencies, request.params.id, async () => {
        await dependencies.prompts!.replace(request.params.id, file, content);
        await dependencies.refreshPromptContext?.(request.params.id);
        return reply.send({ file, content });
      });
    } catch (error) { return sendAgentError(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/avatar", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      const avatar = await dependencies.store.readImageAvatar(request.params.id);
      if (!avatar) return sendApiError(reply, 404, "AVATAR_NOT_FOUND", "Agent 未配置图片头像");
      return reply.header("Cache-Control", "private, max-age=31536000, immutable").type(avatar.mediaType).send(avatar.content);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Querystring: { revision?: string } }>("/api/agents/:id/avatar", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.isMultipart()) return sendApiError(reply, 400, "INVALID_MULTIPART", "请上传图片文件");
    if (typeof request.query.revision !== "string") return sendApiError(reply, 400, "REVISION_REQUIRED", "上传头像必须携带 revision");
    try {
      const part = await request.file({ limits: { files: 1, fileSize: 2 * 1024 * 1024 } });
      if (!part) return sendApiError(reply, 400, "AVATAR_REQUIRED", "请选择头像图片");
      const content = await part.toBuffer();
      const mediaType = detectImageType(content);
      if (!mediaType) return sendApiError(reply, 415, "INVALID_AVATAR_TYPE", "仅支持 PNG、JPEG 或 WebP 图片");
      const updated = await runAgentMutation(
        dependencies,
        request.params.id,
        () => dependencies.store.setImageAvatar(request.params.id, content, mediaType, request.query.revision!),
      );
      return reply.send(updated);
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return sendApiError(reply, 413, "AVATAR_TOO_LARGE", "头像不能超过 2 MB");
      }
      return sendAgentError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.revision !== "string") {
      return sendApiError(reply, 400, "REVISION_REQUIRED", "更新 Agent 必须携带 revision");
    }
    if (body.instructions !== undefined) {
      return sendApiError(reply, 400, "PROMPT_FILES_ONLY", "提示词请通过独立 Markdown 文件接口保存");
    }
    try {
      const updated = await runModelMutation(dependencies, async () => {
        const current = await dependencies.store.get(request.params.id);
        if (!current) throw new DomainError("AGENT_NOT_FOUND", "Agent 不存在");
        const input = readUpdateInput(body);
        await validateModelSelection(input, dependencies, current.profile.defaultModel, current.profile.defaultThinkingLevel);
        return runRuntimeProfileMutation(
          dependencies,
          request.params.id,
          () => dependencies.store.update(request.params.id, input, body.revision as string),
        );
      });
      return reply.send(updated);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/clone", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    try {
      const clone = await runModelMutation(dependencies, () => dependencies.store.clone(request.params.id, {
        name: typeof body.name === "string" ? body.name : undefined,
        copyWorkspace: body.copyWorkspace === true,
      }));
      return reply.code(201).send(clone);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/archive", async (request, reply) => {
    return changeArchiveStatus(request.params.id, true, request.body, reply, dependencies);
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id/archive", async (request, reply) => {
    return changeArchiveStatus(request.params.id, false, request.body, reply, dependencies);
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/delete-preview", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      const agent = await dependencies.store.get(request.params.id);
      if (!agent) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
      const workspace = await summarizeDirectory(agent.profile.cwd);
      const sessionCount = await dependencies.countSessions?.(agent.profile.id) ?? 0;
      return reply.send({ agentId: agent.profile.id, name: agent.profile.name, workspace, sessions: { count: sessionCount } });
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.removeSessions !== "boolean" || typeof body.removeWorkspace !== "boolean") {
      return sendApiError(reply, 400, "DELETE_OPTIONS_REQUIRED", "必须明确选择是否删除 Session 和工作目录");
    }
    let lifecyclePermit: AgentRemovalPermit | undefined;
    let runtimeRemovalStarted = false;
    try {
      lifecyclePermit = await dependencies.beginAgentRemoval?.(request.params.id);
      runtimeRemovalStarted = true;
      await dependencies.removeAgent?.(request.params.id);
      const removed = await dependencies.store.remove(request.params.id, {
        removeSessions: body.removeSessions,
        removeWorkspace: body.removeWorkspace,
      });
      dependencies.finalizeAgentRemoval?.(request.params.id);
      lifecyclePermit?.finalize();
      return reply.send(removed);
    } catch (error) {
      if (runtimeRemovalStarted) dependencies.restoreAgent?.(request.params.id);
      lifecyclePermit?.restore();
      return sendAgentError(reply, error);
    }
  });
}

async function validateModelSelection(
  input: CreateAgentInput | UpdateAgentInput,
  dependencies: AgentRouteDependencies,
  currentModel?: { provider: string; id: string },
  currentThinking?: ThinkingLevel,
): Promise<void> {
  const selected = input.defaultModel === null ? undefined : input.defaultModel ?? currentModel;
  const requestedThinking = input.defaultThinkingLevel === null ? undefined : input.defaultThinkingLevel ?? currentThinking;
  if (!selected) return;
  if (!dependencies.resolveAvailableModel) {
    if (input.defaultModel !== undefined) throw new Error("模型目录尚未就绪");
    return;
  }
  const model = await dependencies.resolveAvailableModel(selected.provider, selected.id);
  if (!model) throw new Error("所选模型当前不可用");
  if (requestedThinking !== undefined && (input.defaultModel !== undefined || input.defaultThinkingLevel !== undefined)) {
    input.defaultThinkingLevel = clampThinkingLevel(model, requestedThinking);
  }
}

function clampThinkingLevel(
  model: { reasoning: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> },
  requested: ThinkingLevel,
): ThinkingLevel {
  const all: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const supported = model.reasoning
    ? all.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null) return false;
        if (level === "xhigh" || level === "max") return mapped !== undefined;
        return true;
      })
    : ["off" as const];
  if (supported.includes(requested)) return requested;
  const requestedIndex = all.indexOf(requested);
  return all.slice(requestedIndex).find((level) => supported.includes(level))
    ?? all.slice(0, requestedIndex).reverse().find((level) => supported.includes(level))
    ?? "off";
}

function detectImageType(content: Buffer): "image/png" | "image/jpeg" | "image/webp" | undefined {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

async function changeArchiveStatus(
  agentId: string,
  archived: boolean,
  requestBody: unknown,
  reply: FastifyReply,
  dependencies: AgentRouteDependencies,
) {
  if (!(await requireAuthentication(reply.request, reply, dependencies.authService))) return;
  const body = isRecord(requestBody) ? requestBody : {};
  if (typeof body.revision !== "string") return sendApiError(reply, 400, "REVISION_REQUIRED", "操作必须携带 revision");
  try {
    const result = await runRuntimeProfileMutation(dependencies, agentId, () => archived
      ? dependencies.store.archive(agentId, body.revision as string)
      : dependencies.store.restore(agentId, body.revision as string));
    return reply.send(result);
  } catch (error) {
    return sendAgentError(reply, error);
  }
}

function runAgentMutation<T>(
  dependencies: AgentRouteDependencies,
  agentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return dependencies.runAgentMutation?.(agentId, operation) ?? operation();
}

function runModelMutation<T>(dependencies: AgentRouteDependencies, operation: () => Promise<T>): Promise<T> {
  return dependencies.runModelMutation?.(operation) ?? operation();
}

async function runRuntimeProfileMutation<T>(
  dependencies: AgentRouteDependencies,
  agentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return runAgentMutation(dependencies, agentId, async () => {
    try {
      // removeAgent 可能在排空租约或落盘检查点时失败；无论失败发生在哪一步，
      // 都必须撤销 RuntimeSupervisor 的删除墓碑，避免 Agent 在本进程内永久不可用。
      await dependencies.removeAgent?.(agentId);
      return await operation();
    } finally {
      dependencies.restoreAgent?.(agentId);
    }
  });
}

function readCreateInput(body: Record<string, unknown>): CreateAgentInput {
  return {
    name: body.name as string,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    avatar: readInitialAvatar(body.avatar),
    defaultModel: readModel(body.defaultModel),
    defaultThinkingLevel: readThinkingLevel(body.defaultThinkingLevel),
    ttsProfileId: typeof body.ttsProfileId === "string" ? body.ttsProfileId : undefined,
    ttsVoice: typeof body.ttsVoice === "string" ? body.ttsVoice : undefined,
    ttsAutoPlay: body.ttsAutoPlay === true,
    ttsStreamPlayback: body.ttsStreamPlayback === true,
    allowedTools: readStringArray(body.allowedTools),
  };
}

function readUpdateInput(body: Record<string, unknown>): UpdateAgentInput {
  const input: UpdateAgentInput = {};
  if (typeof body.name === "string") input.name = body.name;
  if (typeof body.cwd === "string") input.cwd = body.cwd;
  if (typeof body.description === "string") input.description = body.description;
  if (body.avatar !== undefined) input.avatar = readInitialAvatar(body.avatar);
  if (body.defaultModel === null) input.defaultModel = null;
  else if (body.defaultModel !== undefined) input.defaultModel = readModel(body.defaultModel);
  if (body.defaultThinkingLevel === null) input.defaultThinkingLevel = null;
  else if (body.defaultThinkingLevel !== undefined) input.defaultThinkingLevel = readThinkingLevel(body.defaultThinkingLevel);
  if (body.ttsProfileId === null) input.ttsProfileId = null;
  else if (typeof body.ttsProfileId === "string") input.ttsProfileId = body.ttsProfileId;
  if (body.ttsVoice === null) input.ttsVoice = null;
  else if (typeof body.ttsVoice === "string") input.ttsVoice = body.ttsVoice;
  if (typeof body.ttsAutoPlay === "boolean") input.ttsAutoPlay = body.ttsAutoPlay;
  if (typeof body.ttsStreamPlayback === "boolean") input.ttsStreamPlayback = body.ttsStreamPlayback;
  if (body.allowedTools !== undefined) input.allowedTools = readStringArray(body.allowedTools);
  return input;
}

function readInitialAvatar(value: unknown): CreateAgentInput["avatar"] {
  if (!isRecord(value) || value.kind !== "initial" || typeof value.value !== "string") return undefined;
  return { kind: "initial", value: value.value.slice(0, 2) };
}

function readModel(value: unknown): CreateAgentInput["defaultModel"] {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string"
    ? { provider: value.provider, id: value.id }
    : undefined;
}

function readThinkingLevel(value: unknown): CreateAgentInput["defaultThinkingLevel"] {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  return levels.find((level) => level === value);
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

async function summarizeDirectory(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  let entries = 0;
  const deadline = Date.now() + SYSTEM_LIMITS.workspaceScanTimeoutMs;
  const pending = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > SYSTEM_LIMITS.workspaceDepth) throw new DomainError("WORKSPACE_SCAN_LIMIT", "工作区扫描超过系统允许的深度");
    const directory = await opendir(current.path);
    for await (const entry of directory) {
      entries += 1;
      if (entries > SYSTEM_LIMITS.workspaceEntries || Date.now() > deadline) throw new DomainError("WORKSPACE_SCAN_LIMIT", "工作区扫描超过系统允许的范围");
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) pending.push({ path, depth: current.depth + 1 });
      else {
        const info = await lstat(path);
        files += 1;
        bytes += info.size;
      }
    }
  }
  return { files, bytes };
}

function sendAgentError(reply: FastifyReply, error: unknown) {
  if (error instanceof DomainError) {
    return sendApiError(reply, statusForDomainError(error.code), error.code, error.message);
  }
  if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
  if (error instanceof AgentWorkspaceError) {
    const conflicts = new Set(["WORKSPACE_IN_USE", "WORKSPACE_PI_CONFLICT"]);
    return sendApiError(reply, conflicts.has(error.code) ? 409 : 400, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : "Agent 操作失败";
  return sendApiError(reply, 400, "AGENT_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 将路由参数限制为 Agent 可编辑的五个固定提示词文件。 */
function parsePromptFile(value: string): AgentPromptFile | undefined {
  return (["role", "behavior", "rules", "user", "bootsharp"] as const).find((file) => file === value);
}
