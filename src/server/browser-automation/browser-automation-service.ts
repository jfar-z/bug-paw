import type { BrowserAutomationConfig } from "../../shared/browser-automation-contracts";
import type { BrowserCommand, BrowserWorkerUpload, CreateBrowserContextRequest } from "../../shared/browser-worker-protocol";
import { isAbsolute, posix } from "node:path";
import { basename, resolve, sep } from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import mime from "mime";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { BrowserAuditEvent } from "./browser-audit-repository";
import type { BrowserLease, BrowserQueueUpdate } from "./browser-resource-pool";
import { BrowserAutomationError, browserPolicyError } from "./browser-error";

/** 工具调用所能提供的唯一身份字段。 */
export interface BrowserToolContext {
  /** Runtime 当前 Session；其他身份从可信注册表解析。 */
  sessionId: string;
}

interface BrowserAutomationDependencies {
  /** 部署是否包含浏览器组件。 */
  deploymentAvailable: boolean;
  /** 每次操作重新读取配置，覆盖运行期收紧。 */
  readConfig(): Promise<BrowserAutomationConfig>;
  /** 解析可信 Run 身份。 */
  runRegistry: { requireCurrent(sessionId: string): { agentId: string; sessionId: string; runId: string; cwd: string } };
  /** 申请全局浏览器资源。 */
  pool: { acquire(input: { agentId: string; runId: string; signal: AbortSignal; onQueueUpdate?: (update: BrowserQueueUpdate) => void }): Promise<BrowserLease> };
  /** 访问内部 Worker。 */
  worker: {
    createContext(input: CreateBrowserContextRequest, signal?: AbortSignal): Promise<{ contextId: string }>;
    execute<Data>(leaseId: string, command: BrowserCommand, signal?: AbortSignal): Promise<Data>;
    closeContext(leaseId: string, signal?: AbortSignal): Promise<void>;
    readArtifact(leaseId: string, handle: string, maximumBytes: number, signal?: AbortSignal): Promise<Buffer>;
    uploadFile(leaseId: string, name: string, mediaType: string, content: Buffer, maximumBytes: number, signal?: AbortSignal): Promise<BrowserWorkerUpload>;
  };
  /** 签发工作区静态站点预览。 */
  preview: {
    /** 固定内部预览 Origin，仅用于当前部署的 control 网络。 */
    origin: string;
    authorize(input: { cwd: string; runId: string; entryPath: string }): Promise<{ url: string }>;
  };
  /** 主服务工作区产物保存边界。 */
  artifacts: {
    saveScreenshot(input: { cwd: string; runId: string; format: "png" | "jpeg"; content: Buffer }): Promise<unknown>;
    saveDownload(input: { cwd: string; runId: string; originalName: string; mediaType: string; sourceUrl: string; stream: Readable }): Promise<unknown>;
  };
  /** 不记录正文、输入或凭证的最小审计。 */
  audit?: { record(event: BrowserAuditEvent): void };
}

interface ActiveBrowserRun {
  /** 当前资源租约。 */
  lease: BrowserLease;
  /** 当前页面 Origin，用于交互权限判断。 */
  origin?: string;
  /** 当前页面是否属于本地预览。 */
  localPreview: boolean;
}

/** 把可信身份、策略、资源池和 Worker 组合成原子浏览器操作。 */
export class BrowserAutomationService {
  /** 已创建 Context 的 Run 状态。 */
  private readonly active = new Map<string, ActiveBrowserRun>();

  /** 创建浏览器策略编排服务。 */
  constructor(private readonly dependencies: BrowserAutomationDependencies) {}

  /** 打开公网 URL 或当前工作区 HTML。 */
  async open(
    context: BrowserToolContext,
    input: { url?: string; path?: string; newPage?: boolean },
    signal: AbortSignal,
    onQueueUpdate?: (update: BrowserQueueUpdate) => void,
  ): Promise<unknown> {
    if ((input.url ? 1 : 0) + (input.path ? 1 : 0) !== 1) {
      throw new BrowserAutomationError("BROWSER_WORKER_PROTOCOL_INVALID", "browser_open 必须且只能提供 url 或 path", false);
    }
    const identity = this.dependencies.runRegistry.requireCurrent(context.sessionId);
    if (input.url) {
      return this.execute(context, { type: "open", target: { kind: "url", url: input.url }, newPage: input.newPage ?? false }, signal, onQueueUpdate);
    }
    await this.requireAvailable();
    const path = input.path!;
    const normalized = posix.normalize(path);
    if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || normalized === ".." || normalized.startsWith("../")) {
      throw new BrowserAutomationError("BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE", "本地页面文件不在当前 Agent 工作目录", false);
    }
    const grant = await this.dependencies.preview.authorize({ cwd: identity.cwd, runId: identity.runId, entryPath: normalized });
    return this.execute(context, { type: "open", target: { kind: "preview", url: grant.url }, newPage: input.newPage ?? false }, signal, onQueueUpdate);
  }

  /** 执行单个已类型化的浏览器命令。 */
  async execute(
    context: BrowserToolContext,
    command: BrowserCommand,
    signal: AbortSignal,
    onQueueUpdate?: (update: BrowserQueueUpdate) => void,
  ): Promise<unknown> {
    const config = await this.requireAvailable();
    const identity = this.dependencies.runRegistry.requireCurrent(context.sessionId);
    let active: ActiveBrowserRun | undefined;
    try {
      active = await this.ensureContext(identity, config, signal, onQueueUpdate);
      if (command.type === "open") {
        if (command.target.kind === "url") this.assertNavigation(command.target.url, config);
        active.localPreview = command.target.kind === "preview";
        active.origin = new URL(command.target.url).origin;
      } else {
        this.assertInteraction(command, active, config);
      }
      const result = await this.dependencies.worker.execute<unknown>(active.lease.id, command, signal);
      let output = result;
      if ((command.type === "screenshot" || command.type === "download") && isArtifactResult(result)) {
        const maximum = command.type === "download" ? config.artifacts.maxDownloadBytes : 50 * 1024 * 1024;
        const content = await this.dependencies.worker.readArtifact(active.lease.id, result.artifact.handle, maximum, signal);
        if (command.type === "screenshot") {
          output = await this.dependencies.artifacts.saveScreenshot({ cwd: identity.cwd, runId: identity.runId, format: command.format, content });
        } else {
          const originalName = result.artifact.suggestedName ?? "download.bin";
          const mediaType = result.artifact.mediaType === "application/octet-stream" ? mime.getType(originalName) ?? result.artifact.mediaType : result.artifact.mediaType;
          const sourceUrl = command.source.kind === "url" ? command.source.url : active.origin ?? "unknown";
          output = await this.dependencies.artifacts.saveDownload({ cwd: identity.cwd, runId: identity.runId, originalName, mediaType, sourceUrl, stream: Readable.from(content) });
        }
      }
      this.recordAudit(identity, command.type, active.origin, "allowed", output);
      return output;
    } catch (error) {
      this.recordAudit(identity, command.type, active?.origin, error instanceof BrowserAutomationError ? "blocked" : "failed", undefined, error);
      throw error;
    }
  }

  /** 校验并复制当前工作区文件后执行上传。 */
  async upload(
    context: BrowserToolContext,
    input: { pageId?: string; ref: string; paths: string[] },
    signal: AbortSignal,
    onQueueUpdate?: (update: BrowserQueueUpdate) => void,
  ): Promise<unknown> {
    const config = await this.requireAvailable();
    const identity = this.dependencies.runRegistry.requireCurrent(context.sessionId);
    const active = await this.ensureContext(identity, config, signal, onQueueUpdate);
    try {
      this.assertInteraction({ type: "upload", ref: input.ref, files: [] }, active, config);
      const files: BrowserWorkerUpload[] = [];
      for (const path of input.paths) {
        const file = await readWorkspaceUpload(identity.cwd, path);
        files.push(await this.dependencies.worker.uploadFile(active.lease.id, file.name, file.mediaType, file.content, 20 * 1024 * 1024, signal));
      }
      const result = await this.dependencies.worker.execute(active.lease.id, {
        type: "upload",
        ref: input.ref,
        ...(input.pageId ? { pageId: input.pageId } : {}),
        files,
      }, signal);
      this.recordAudit(identity, "upload", active.origin, "allowed");
      return result;
    } catch (error) {
      this.recordAudit(identity, "upload", active.origin, error instanceof BrowserAutomationError ? "blocked" : "failed", undefined, error);
      throw error;
    }
  }

  /** Run 结束时释放 Context；不存在时保持幂等。 */
  async finishRun(runId: string, reason: "run_completed" | "run_aborted" | "run_error"): Promise<void> {
    const active = this.active.get(runId);
    if (!active) return;
    this.active.delete(runId);
    await active.lease.release(reason);
  }

  /** 读取并校验能力开关。 */
  private async requireAvailable(): Promise<BrowserAutomationConfig> {
    if (!this.dependencies.deploymentAvailable) throw new BrowserAutomationError("BROWSER_DEPLOYMENT_UNAVAILABLE", "当前部署未启用浏览器执行组件", false);
    const config = await this.dependencies.readConfig();
    if (!config.enabled) throw new BrowserAutomationError("BROWSER_CAPABILITY_DISABLED", "浏览器执行能力当前已关闭", false);
    return config;
  }

  /** 首次调用阻塞申请资源并创建隔离 Context。 */
  private async ensureContext(
    identity: { agentId: string; runId: string },
    config: BrowserAutomationConfig,
    signal: AbortSignal,
    onQueueUpdate?: (update: BrowserQueueUpdate) => void,
  ): Promise<ActiveBrowserRun> {
    const existing = this.active.get(identity.runId);
    if (existing) {
      existing.lease.heartbeat();
      return existing;
    }
    const lease = await this.dependencies.pool.acquire({ agentId: identity.agentId, runId: identity.runId, signal, ...(onQueueUpdate ? { onQueueUpdate } : {}) });
    try {
      await this.dependencies.worker.createContext({
        leaseId: lease.id,
        egress: {
          leaseId: lease.id,
          expiresAt: lease.acquiredAt + config.pool.runTimeoutMs,
          trustedOrigins: [...new Set([this.dependencies.preview.origin, ...config.trustedOrigins.map(({ origin }) => origin)])],
        },
        permissionGrants: [
          { origin: this.dependencies.preview.origin, permissions: [...new Set(config.localPreview.grantedPermissions)] },
          ...config.trustedOrigins.map(({ origin, grantedPermissions }) => ({ origin, permissions: [...new Set(grantedPermissions)] })),
        ].filter(({ permissions }) => permissions.length > 0),
        maxPages: config.publicBrowsing.maxPagesPerContext,
      }, signal);
    } catch (error) {
      await lease.release("run_error");
      throw error;
    }
    const active = { lease, localPreview: false };
    this.active.set(identity.runId, active);
    return active;
  }

  /** 校验公网 HTTPS 或精确受信任 Origin。 */
  private assertNavigation(value: string, config: BrowserAutomationConfig): void {
    let url: URL;
    try { url = new URL(value); } catch { throw new BrowserAutomationError("BROWSER_PRIVATE_NETWORK_BLOCKED", "浏览器地址格式无效", false); }
    if (url.username || url.password) throw new BrowserAutomationError("BROWSER_PRIVATE_NETWORK_BLOCKED", "浏览器地址不能包含凭证", false);
    if (config.trustedOrigins.some(({ origin }) => origin === url.origin)) return;
    if (url.protocol !== "https:") throw new BrowserAutomationError("BROWSER_PRIVATE_NETWORK_BLOCKED", "公开浏览仅允许 HTTPS 站点", false);
    if (config.publicBrowsing.allowedDomains.length > 0 && !config.publicBrowsing.allowedDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      throw new BrowserAutomationError("BROWSER_PRIVATE_NETWORK_BLOCKED", "目标域名不在公开浏览允许范围内", false);
    }
  }

  /** 对高风险 UI 操作应用精确 Origin 开关。 */
  private assertInteraction(command: BrowserCommand, active: ActiveBrowserRun, config: BrowserAutomationConfig): void {
    if (command.type !== "input" && command.type !== "submit" && command.type !== "upload") return;
    const policy = active.localPreview
      ? config.localPreview
      : config.trustedOrigins.find(({ origin }) => origin === active.origin);
    if (!policy) throw browserPolicyError("BROWSER_ORIGIN_NOT_TRUSTED", { operation: command.type, origin: active.origin, requiredSetting: "trustedOrigins" });
    const setting = command.type === "input" ? "allowTextInput" : command.type === "submit" ? "allowFormSubmit" : "allowFileUpload";
    const code = command.type === "input" ? "BROWSER_TEXT_INPUT_DISABLED" : command.type === "submit" ? "BROWSER_FORM_SUBMIT_DISABLED" : "BROWSER_UPLOAD_DISABLED";
    if (!policy[setting]) throw browserPolicyError(code, { operation: command.type, origin: active.origin, requiredSetting: setting, scope: active.localPreview ? "local_preview" : "trusted_ui_origin" });
  }

  /** 写入不包含页面内容和输入值的审计事实。 */
  private recordAudit(
    identity: { agentId: string; sessionId: string; runId: string },
    operation: BrowserCommand["type"],
    origin: string | undefined,
    decision: BrowserAuditEvent["decision"],
    result?: unknown,
    error?: unknown,
  ): void {
    if (!this.dependencies.audit) return;
    const artifact = isSavedArtifact(result) ? result : undefined;
    this.dependencies.audit.record({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      runId: identity.runId,
      toolName: `browser_${operation}`,
      operation,
      ...(origin ? { origin } : {}),
      decision,
      ...(error instanceof BrowserAutomationError ? { errorCode: error.code } : {}),
      ...(artifact ? { artifact } : {}),
    });
  }
}

/** 读取无符号链接、严格位于工作区内的上传文件。 */
async function readWorkspaceUpload(cwdInput: string, path: string): Promise<{ name: string; mediaType: string; content: Buffer }> {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path)) throw outsideUploadError();
  const cwd = await realpath(cwdInput);
  const target = resolve(cwd, path);
  if (target !== cwd && !target.startsWith(`${cwd}${sep}`)) throw outsideUploadError();
  try {
    const info = await lstat(target);
    const actual = await realpath(target);
    if (!info.isFile() || info.isSymbolicLink() || actual !== target || info.size > 20 * 1024 * 1024) throw outsideUploadError();
    return { name: basename(target), mediaType: mime.getType(target) ?? "application/octet-stream", content: await readFile(target) };
  } catch (error) {
    if (error instanceof BrowserAutomationError) throw error;
    throw outsideUploadError();
  }
}

function outsideUploadError(): BrowserAutomationError {
  return new BrowserAutomationError("BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE", "上传文件不在当前 Agent 工作目录或不是普通文件", false);
}

/** 判断 Worker 结果是否仅包含一次性产物句柄。 */
function isArtifactResult(value: unknown): value is { artifact: { handle: string; mediaType: string; size: number; suggestedName?: string } } {
  if (typeof value !== "object" || value === null || !("artifact" in value)) return false;
  const artifact = (value as { artifact?: unknown }).artifact;
  return typeof artifact === "object" && artifact !== null
    && typeof (artifact as { handle?: unknown }).handle === "string"
    && typeof (artifact as { mediaType?: unknown }).mediaType === "string"
    && typeof (artifact as { size?: unknown }).size === "number";
}

/** 识别主服务已保存且可公开审计的产物元数据。 */
function isSavedArtifact(value: unknown): value is { path: string; mediaType: string; size: number; sha256: string } {
  return typeof value === "object" && value !== null
    && typeof (value as { path?: unknown }).path === "string"
    && typeof (value as { mediaType?: unknown }).mediaType === "string"
    && typeof (value as { size?: unknown }).size === "number"
    && typeof (value as { sha256?: unknown }).sha256 === "string";
}
