import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentStore } from "../agents/agent-store";
import { ConfigurationOperationsService } from "../configuration/configuration-operations-service";
import { scrubSecrets } from "../configuration/configuration-operations-service";
import { ConfigHistory } from "../configuration/config-history";
import { DiagnosticsService } from "../configuration/diagnostics-service";
import { PiSettingsService } from "../configuration/pi-settings-service";
import { RuntimeRefreshError } from "../runtime-coordinator";
import { createVersionedJsonStore, VersionConflictError } from "../configuration/versioned-json-store";
import type { DataPaths } from "../paths";
import type { ConfigurationHistoryRepository } from "../configuration/configuration-history-repository";
import type { DiagnosticsReport } from "../configuration/diagnostics-service";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface ConfigurationRouteDependencies {
  authService: AuthService;
  paths: DataPaths;
  agents: AgentStore;
  refreshRuntime?: () => Promise<{ abortedSessions: number }>;
  historyRepository?: ConfigurationHistoryRepository;
  backgroundErrors?: () => { total: number; latestCode?: string; latestAt?: string };
  operationalStatus?: () => NonNullable<DiagnosticsReport["operational"]>;
  runAgentMutation?<T>(agentId: string, operation: () => Promise<T>): Promise<T>;
  refreshAgent?: (agentId: string) => Promise<void>;
  runModelMutation?<T>(operation: () => Promise<T>): Promise<T>;
}

interface SettingShape { [key: string]: true | SettingShape }
interface SettingValidationError {
  code: "UNKNOWN_SETTING" | "INVALID_SETTING_TYPE" | "GLOBAL_ONLY_SETTING" | "SETTING_OUT_OF_RANGE";
  message: string;
}

const SETTING_SHAPE: SettingShape = {
  defaultProvider: true, defaultModel: true, defaultThinkingLevel: true, transport: true,
  steeringMode: true, followUpMode: true,
  compaction: { enabled: true, reserveTokens: true, keepRecentTokens: true },
  branchSummary: { reserveTokens: true, skipPrompt: true },
  retry: { enabled: true, maxRetries: true, baseDelayMs: true, provider: { timeoutMs: true, maxRetries: true, maxRetryDelayMs: true } },
  hideThinkingBlock: true,
  thinkingBudgets: { minimal: true, low: true, medium: true, high: true },
  images: { autoResize: true, blockImages: true },
  shellPath: true, shellCommandPrefix: true, npmCommand: true, httpProxy: true,
  httpIdleTimeoutMs: true, websocketConnectTimeoutMs: true,
  packages: true, extensions: true, skills: true, prompts: true,
};

const NUMERIC_RANGES: Record<string, [number, number]> = {
  "compaction.reserveTokens": [0, 10_000_000], "compaction.keepRecentTokens": [0, 10_000_000],
  "branchSummary.reserveTokens": [0, 10_000_000], "retry.maxRetries": [0, 20],
  "retry.baseDelayMs": [0, 600_000], "retry.provider.timeoutMs": [100, 3_600_000],
  "retry.provider.maxRetries": [0, 20], "retry.provider.maxRetryDelayMs": [0, 600_000],
  "thinkingBudgets.minimal": [0, 10_000_000], "thinkingBudgets.low": [0, 10_000_000],
  "thinkingBudgets.medium": [0, 10_000_000], "thinkingBudgets.high": [0, 10_000_000],
  httpIdleTimeoutMs: [100, 3_600_000], websocketConnectTimeoutMs: [100, 3_600_000],
};

/**
 * 注册全局与 Agent 作用域 Pi 设置接口。
 */
export function registerConfigurationRoutes(app: FastifyInstance, dependencies: ConfigurationRouteDependencies): void {
  const operations = new ConfigurationOperationsService(dependencies.paths, dependencies.agents);
  const diagnostics = new DiagnosticsService({
    paths: dependencies.paths,
    agents: dependencies.agents,
    backgroundErrors: dependencies.backgroundErrors,
    operationalStatus: dependencies.operationalStatus,
  });
  const history = new ConfigHistory(dependencies.paths.historyDir, dependencies.historyRepository);
  app.addHook("onClose", async () => operations.dispose());

  app.get("/api/configuration/global", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send(await globalService(dependencies).read("global"));
  });

  app.patch("/api/configuration/global", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return updateSettings("global", undefined, request.body, reply, dependencies, history);
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/settings", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const agent = await dependencies.agents.get(request.params.id);
    if (!agent) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
    return reply.send(await agentService(dependencies, agent.profile.cwd).read("agent"));
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id/settings", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return runAgentMutation(dependencies, request.params.id, () => updateSettings("agent", request.params.id, request.body, reply, dependencies, history));
  });

  app.get("/api/configuration/diagnostics", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    return reply.send(await diagnostics.run());
  });

  app.post("/api/configuration/refresh-runtime", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    try {
      const refresh = () => dependencies.refreshRuntime?.() ?? Promise.resolve({ abortedSessions: 0 });
      return reply.send(await (dependencies.runModelMutation?.(refresh) ?? refresh()));
    } catch (error) {
      if (error instanceof RuntimeRefreshError) {
        return sendApiError(reply, 409, error.code, error.message);
      }
      return sendApiError(reply, 500, "RUNTIME_REFRESH_FAILED", "Pi 配置刷新失败");
    }
  });

  app.get("/api/configuration/export", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", `attachment; filename="pi-configuration-${new Date().toISOString().slice(0, 10)}.json"`);
    return reply.send(await operations.exportSafe());
  });

  app.post("/api/configuration/import/preview", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    return reply.send(await operations.preview(request.body));
  });

  app.post("/api/configuration/import/apply", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    const body = isRecord(request.body) ? request.body : {};
    if (body.confirmed !== true || typeof body.previewId !== "string") {
      return sendApiError(reply, 400, "IMPORT_CONFIRMATION_REQUIRED", "应用导入前必须确认预览结果");
    }
    try {
      let runtimeRefreshRequired = false;
      const apply = async () => {
        await operations.apply(body.previewId as string);
        try { await dependencies.refreshRuntime?.(); } catch { runtimeRefreshRequired = true; }
      };
      await (dependencies.runModelMutation?.(apply) ?? apply());
      return reply.send({ applied: true, runtimeRefreshRequired });
    } catch (error) {
      if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
      return sendApiError(reply, 400, "IMPORT_INVALID", error instanceof Error ? error.message : "导入失败");
    }
  });

  app.get("/api/configuration/history", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    return reply.send({ entries: await history.list() });
  });

  app.post<{ Params: { id: string } }>("/api/configuration/history/:id/restore", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.revision !== "string") return sendApiError(reply, 400, "REVISION_REQUIRED", "恢复前必须提供当前 revision");
    const snapshot = await history.getSnapshot(request.params.id);
    if (!snapshot) return sendApiError(reply, 404, "HISTORY_NOT_RESTORABLE", "历史记录没有可恢复快照");
    try {
      const restore = async () => {
        const agent = snapshot.scope === "agent" && snapshot.targetId ? await dependencies.agents.get(snapshot.targetId) : undefined;
        if (snapshot.scope === "agent" && !agent) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
        await validateSettingsSnapshot(snapshot.value, snapshot.scope, dependencies.paths, agent?.profile.cwd);
        const target = snapshot.scope === "global" ? join(dependencies.paths.piDir, "settings.json") : join(agent!.profile.cwd, ".pi", "settings.json");
        const written = await createVersionedJsonStore<Record<string, unknown>>(target).write(snapshot.value, body.revision as string);
        try {
          if (snapshot.scope === "agent" && snapshot.targetId) await dependencies.refreshAgent?.(snapshot.targetId);
          return reply.send(snapshot.scope === "global"
            ? await globalService(dependencies).read("global")
            : await agentService(dependencies, agent!.profile.cwd).read("agent"));
        } catch {
          // 文件恢复已经提交；Runtime 刷新或响应重读失败时返回已提交 revision，禁止客户端重试写入。
          return reply.send({
            revision: written.revision,
            own: scrubSecrets(snapshot.value),
            effective: scrubSecrets(snapshot.value),
            diagnostics: [{ source: "settings", severity: "warning", code: "RUNTIME_REFRESH_REQUIRED", message: "设置已恢复，请手动刷新 Runtime" }],
          });
        }
      };
      return snapshot.scope === "agent" && snapshot.targetId
        ? await runAgentMutation(dependencies, snapshot.targetId, restore)
        : await restore();
    } catch (error) {
      if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
      return sendApiError(reply, 400, "HISTORY_RESTORE_INVALID", error instanceof Error ? error.message : "恢复失败");
    }
  });
}

async function updateSettings(
  scope: "global" | "agent",
  agentId: string | undefined,
  requestBody: unknown,
  reply: FastifyReply,
  dependencies: ConfigurationRouteDependencies,
  history: ConfigHistory,
) {
  const body = isRecord(requestBody) ? requestBody : {};
  if (typeof body.revision !== "string" || !isRecord(body.set) || !Array.isArray(body.inherit) || !body.inherit.every((item) => typeof item === "string")) {
    return sendApiError(reply, 400, "INVALID_SETTINGS_REQUEST", "必须提供 revision、set 和 inherit");
  }
  const validation = validateSettings(body.set, body.inherit as string[], scope);
  if (validation) return sendApiError(reply, 400, validation.code, validation.message);
  let updated: Awaited<ReturnType<PiSettingsService["update"]>>;
  let previous: Awaited<ReturnType<ReturnType<typeof createVersionedJsonStore<Record<string, unknown>>>["read"]>>;
  try {
    let service: PiSettingsService;
    let file: string;
    if (scope === "global") service = globalService(dependencies);
    else {
      const agent = agentId ? await dependencies.agents.get(agentId) : undefined;
      if (!agent) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
      service = agentService(dependencies, agent.profile.cwd);
    }
    file = scope === "global" ? join(dependencies.paths.piDir, "settings.json") : join((await dependencies.agents.get(agentId!))!.profile.cwd, ".pi", "settings.json");
    previous = await createVersionedJsonStore<Record<string, unknown>>(file).read();
    updated = await service.update(scope, { set: body.set, inherit: body.inherit as string[] }, body.revision);
  } catch (error) {
    if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
    return sendApiError(reply, 400, "SETTINGS_INVALID", error instanceof Error ? error.message : "设置更新失败");
  }
  try {
    const historyId = randomUUID();
    const restorable = previous.value !== undefined && !containsSensitiveSetting(previous.value);
    if (restorable) await history.recordSnapshot({ id: historyId, scope, targetId: agentId, revision: previous.revision, value: previous.value! });
    await history.record({ id: historyId, createdAt: new Date().toISOString(), scope, targetId: agentId, summary: scope === "global" ? "更新全局 Pi 设置" : "更新 Agent Pi 设置", outcome: "success", restorable });
    if (scope === "agent" && agentId) await dependencies.refreshAgent?.(agentId);
  } catch {
    // settings.json 已 durable 提交；历史快照或 Runtime 刷新属于提交后维护，不能让客户端误以为可重试写入。
  }
  return reply.send(updated);
}

function runAgentMutation<T>(dependencies: ConfigurationRouteDependencies, agentId: string, operation: () => Promise<T>): Promise<T> {
  return dependencies.runAgentMutation?.(agentId, operation) ?? operation();
}

async function validateSettingsSnapshot(
  value: Record<string, unknown>,
  scope: "global" | "agent",
  paths: DataPaths,
  agentCwd?: string,
): Promise<void> {
  await mkdir(paths.transactionDir, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(paths.transactionDir, "settings-validate-"));
  const agentDir = join(root, "pi");
  const cwd = join(root, "cwd");
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    if (scope === "global") {
      await writeFile(join(agentDir, "settings.json"), JSON.stringify(value), "utf8");
    } else {
      try { await writeFile(join(agentDir, "settings.json"), await readFile(join(paths.piDir, "settings.json"), "utf8"), "utf8"); } catch { /* 全局设置缺失时按空配置校验。 */ }
      await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(value), "utf8");
    }
    const errors = SettingsManager.create(cwd, agentDir).drainErrors();
    if (errors.length > 0) throw new TypeError(errors[0].error.message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function containsSensitiveSetting(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveSetting);
  if (!isRecord(value)) return typeof value === "string" && /:\/\/[^/@\s]+:[^/@\s]+@/u.test(value);
  return Object.entries(value).some(([key, child]) => /authorization|api[_-]?key|token|secret|password/iu.test(key) || containsSensitiveSetting(child));
}

function validateSettings(
  set: Record<string, unknown>,
  inherit: string[],
  scope: "global" | "agent",
): SettingValidationError | undefined {
  const paths: Array<[string, unknown]> = [];
  const walk = (value: Record<string, unknown>, shape: SettingShape, prefix = ""): SettingValidationError | undefined => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const expected = shape[key];
      if (expected === undefined) return { code: "UNKNOWN_SETTING", message: `不支持的设置字段：${path}` };
      if (expected !== true) {
        if (!isRecord(child)) return { code: "INVALID_SETTING_TYPE", message: `${path} 必须是对象` };
        const nested = walk(child, expected, path);
        if (nested) return nested;
      } else paths.push([path, child]);
    }
    return undefined;
  };
  const invalid = walk(set, SETTING_SHAPE);
  if (invalid) return invalid;
  for (const path of inherit) {
    if (!isAllowedPath(path)) return { code: "UNKNOWN_SETTING", message: `不支持的继承字段：${path}` };
  }
  if (scope === "agent" && (Object.prototype.hasOwnProperty.call(set, "httpProxy") || inherit.includes("httpProxy"))) {
    return { code: "GLOBAL_ONLY_SETTING", message: "httpProxy 只能在全局作用域修改" };
  }
  for (const [path, value] of paths) {
    const range = NUMERIC_RANGES[path];
    if (range && (typeof value !== "number" || !Number.isFinite(value) || value < range[0] || value > range[1])) {
      return { code: "SETTING_OUT_OF_RANGE", message: `${path} 必须在 ${range[0]} 到 ${range[1]} 之间` };
    }
  }
  return undefined;
}

function isAllowedPath(path: string): boolean {
  const parts = path.split(".");
  let shape: true | SettingShape = SETTING_SHAPE;
  for (const part of parts) {
    if (shape === true || shape[part] === undefined) return false;
    shape = shape[part];
  }
  return shape === true;
}

function globalService(dependencies: ConfigurationRouteDependencies) {
  return new PiSettingsService({ agentDir: dependencies.paths.piDir, cwd: dependencies.paths.workspaceDir });
}

function agentService(dependencies: ConfigurationRouteDependencies, cwd: string) {
  return new PiSettingsService({ agentDir: dependencies.paths.piDir, cwd });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
