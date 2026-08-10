import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, sep } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ConfigurationDiagnostic } from "../../shared/configuration-contracts";
import type { AgentStore } from "../agents/agent-store";
import type { DataPaths } from "../paths";
import { toSafePublicMessage } from "../core/errors";
import { ResourceService } from "../resources/resource-service";

/**
 * 容器持久化挂载的公开状态。
 */
export interface DiagnosticMount {
  source: string;
  target: string;
  writable: boolean;
}

/**
 * 配置中心诊断报告。
 */
export interface DiagnosticsReport {
  generatedAt: string;
  version: { app: string; node: string; pi: string };
  mounts: DiagnosticMount[];
  diagnostics: ConfigurationDiagnostic[];
  backgroundErrors?: { total: number; latestCode?: string; latestAt?: string };
  operational?: {
    database: { quickCheck: string; journalMode: string };
    runtime: { activeLeases: number; trackedAgents: number };
    limits: Record<string, number>;
  };
}

interface DiagnosticsServiceOptions {
  paths: DataPaths;
  agents: AgentStore;
  version?: string;
  checkWritable?: (path: string) => Promise<boolean>;
  readMounts?: () => Promise<DiagnosticMount[]>;
  loadResources?: (cwd: string) => Promise<{ diagnostics: Array<{ type: string; message: string; path?: string }> }>;
  backgroundErrors?: () => { total: number; latestCode?: string; latestAt?: string };
  operationalStatus?: () => NonNullable<DiagnosticsReport["operational"]>;
}

type JsonRecord = Record<string, unknown>;

/**
 * 聚合 Pi 配置、目录权限、挂载和资源加载状态，并在边界统一脱敏。
 */
export class DiagnosticsService {
  private readonly options: DiagnosticsServiceOptions;

  /**
   * 创建诊断服务。
   *
   * @param options 数据路径与可替换的系统检查依赖
   */
  constructor(options: DiagnosticsServiceOptions) {
    this.options = options;
  }

  /**
   * 执行只读诊断，不修改任何配置文件。
   */
  async run(): Promise<DiagnosticsReport> {
    const diagnostics: ConfigurationDiagnostic[] = [];
    const modelsPath = join(this.options.paths.piDir, "models.json");
    const authPath = join(this.options.paths.piDir, "auth.json");
    const models = await readJsonRecord(modelsPath, diagnostics, "models");
    const auth = await readJsonRecord(authPath, diagnostics, "auth");

    await this.checkModels(modelsPath, authPath, diagnostics);
    this.checkCredentials(models, auth, diagnostics);
    await this.checkDirectories(diagnostics);
    await this.checkResources(diagnostics);

    const mounts = await (this.options.readMounts ?? (() => readRelevantMounts(this.options.paths.rootDir)))();
    if (mounts.length === 0) {
      diagnostics.push({ source: "runtime", severity: "warning", code: "DATA_MOUNT_NOT_DETECTED", message: "未检测到数据目录对应的容器挂载" });
    }

    return sanitizeReport({
      generatedAt: new Date().toISOString(),
      version: {
        app: this.options.version ?? process.env.npm_package_version ?? "0.1.0",
        node: process.version,
        pi: "0.83.0",
      },
      mounts,
      diagnostics,
      ...(this.options.backgroundErrors ? { backgroundErrors: this.options.backgroundErrors() } : {}),
      ...(this.options.operationalStatus ? { operational: this.options.operationalStatus() } : {}),
    });
  }

  private async checkModels(modelsPath: string, authPath: string, diagnostics: ConfigurationDiagnostic[]): Promise<void> {
    try {
      const runtime = await ModelRuntime.create({ modelsPath, authPath, allowModelNetwork: false });
      const error = runtime.getError();
      if (error) {
        diagnostics.push({ source: "models", severity: "error", code: "PI_MODELS_INVALID", message: error });
      }
    } catch (error) {
      diagnostics.push({ source: "models", severity: "error", code: "PI_MODELS_INVALID", message: errorMessage(error, "模型配置无法解析") });
    }
  }

  private checkCredentials(models: JsonRecord, auth: JsonRecord, diagnostics: ConfigurationDiagnostic[]): void {
    const providers = isRecord(models.providers) ? models.providers : {};
    for (const [providerId, value] of Object.entries(providers)) {
      const provider = isRecord(value) ? value : {};
      const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
      const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/iu.test(baseUrl);
      if (!local && !Object.prototype.hasOwnProperty.call(auth, providerId)) {
        diagnostics.push({
          source: "auth",
          severity: "warning",
          code: "PROVIDER_CREDENTIAL_MISSING",
          message: `Provider ${providerId} 尚未配置凭证`,
          field: providerId,
        });
      }
    }
  }

  private async checkDirectories(diagnostics: ConfigurationDiagnostic[]): Promise<void> {
    const writable = this.options.checkWritable ?? defaultWritableCheck;
    const sessionDir = join(this.options.paths.piDir, "sessions");
    if (!(await writable(sessionDir))) {
      diagnostics.push({ source: "runtime", severity: "error", code: "SESSION_DIR_NOT_WRITABLE", message: "Session 目录不可写", field: sessionDir });
    }
    for (const { profile } of await this.options.agents.list()) {
      if (!(await writable(profile.cwd))) {
        diagnostics.push({ source: "runtime", severity: "error", code: "AGENT_CWD_NOT_WRITABLE", message: `Agent ${profile.name} 工作目录不可写`, field: profile.id });
      }
    }
  }

  private async checkResources(diagnostics: ConfigurationDiagnostic[]): Promise<void> {
    const load = this.options.loadResources ?? (async (cwd: string) => new ResourceService({ agentDir: this.options.paths.piDir, cwd }).catalog());
    const workspaces = new Set([this.options.paths.workspaceDir, ...(await this.options.agents.list()).map(({ profile }) => profile.cwd)]);
    for (const cwd of workspaces) {
      try {
        const catalog = await load(cwd);
        diagnostics.push(...catalog.diagnostics.map((item) => ({
          source: "resource" as const,
          severity: item.type === "error" ? "error" as const : "warning" as const,
          code: "RESOURCE_LOAD_ERROR",
          message: item.message,
          field: item.path,
        })));
      } catch (error) {
        diagnostics.push({ source: "resource", severity: "error", code: "RESOURCE_LOAD_ERROR", message: errorMessage(error, "资源目录无法加载") });
      }
    }
  }
}

async function defaultWritableCheck(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonRecord(path: string, diagnostics: ConfigurationDiagnostic[], source: "models" | "auth"): Promise<JsonRecord> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (isRecord(value)) return value;
    diagnostics.push({ source, severity: "error", code: source === "models" ? "PI_MODELS_INVALID" : "PI_AUTH_INVALID", message: `${source}.json 顶层必须是对象` });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({ source, severity: "error", code: source === "models" ? "PI_MODELS_INVALID" : "PI_AUTH_INVALID", message: errorMessage(error, `${source}.json 无法解析`) });
    }
  }
  return {};
}

async function readRelevantMounts(rootDir: string): Promise<DiagnosticMount[]> {
  try {
    const lines = (await readFile("/proc/self/mountinfo", "utf8")).split("\n").filter(Boolean);
    const mounts = lines.flatMap((line): DiagnosticMount[] => {
      const [left, right] = line.split(" - ");
      if (!left || !right) return [];
      const fields = left.split(" ");
      const target = decodeMountPath(fields[4] ?? "");
      const source = right.split(" ")[1] ?? "unknown";
      return [{ source, target, writable: (fields[5] ?? "").split(",").includes("rw") }];
    });
    const resolvedRoot = resolve(rootDir);
    const relevant = mounts.filter(({ target }) => resolvedRoot === target || resolvedRoot.startsWith(`${target}${sep}`));
    const longest = relevant.sort((a, b) => b.target.length - a.target.length)[0];
    return longest ? [longest] : [];
  } catch {
    return [];
  }
}

function decodeMountPath(value: string): string {
  return value.replace(/\\040/gu, " ").replace(/\\011/gu, "\t").replace(/\\012/gu, "\n").replace(/\\134/gu, "\\");
}

function sanitizeReport(report: DiagnosticsReport): DiagnosticsReport {
  return JSON.parse(sanitizeText(JSON.stringify(report))) as DiagnosticsReport;
}

function sanitizeText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer [REDACTED]")
    .replace(/(authorization|api[_-]?key|token|secret|password)(\\?"?\s*[:=]\s*\\?"?)[^\s,}"\\]+/giu, "$1$2[REDACTED]")
    .replace(/\b(?:sk|ghp)_[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]");
}

function errorMessage(error: unknown, fallback: string): string {
  return toSafePublicMessage(error, fallback);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
