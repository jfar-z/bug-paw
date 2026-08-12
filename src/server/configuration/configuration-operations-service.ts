import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import type { AgentStore } from "../agents/agent-store";
import type { DataPaths } from "../paths";
import { writeJsonAtomic } from "../storage";
import { ConfigTransaction } from "./config-transaction";
import { createVersionedJsonStore } from "./versioned-json-store";
import { ImportPreviewRegistry } from "./import-preview-registry";

type JsonRecord = Record<string, unknown>;

/**
 * 可移植且默认不包含凭证明文的配置包。
 */
export interface SafeConfigurationBundle {
  version: 1;
  exportedAt: string;
  files: {
    models: { revision: string; value: JsonRecord };
    settings: { revision: string; value: JsonRecord };
    agents: unknown[];
  };
}

/**
 * 导入预览公开结果。
 */
export interface ConfigurationImportPreview {
  previewId: string;
  added: string[];
  changed: string[];
  conflicts: string[];
  invalid: Array<{ file: string; message: string }>;
}

interface PendingImport {
  files: Array<{ name: "models" | "settings"; path: string; expectedRevision: string; value: JsonRecord }>;
  blocked: boolean;
}

/**
 * 已应用的配置文件集合。
 */
export interface ConfigurationApplyResult {
  files: Array<"models" | "settings">;
}

/**
 * 管理安全导出、无副作用导入预览和 revision 保护的导入应用。
 */
export class ConfigurationOperationsService {
  private readonly paths: DataPaths;
  private readonly agents: AgentStore;
  private readonly pending = new ImportPreviewRegistry<PendingImport>();

  /**
   * 创建配置运维服务。
   *
   * @param paths 数据目录
   * @param agents Agent 仓库
   */
  constructor(paths: DataPaths, agents: AgentStore) {
    this.paths = paths;
    this.agents = agents;
  }

  /**
   * 导出不含 auth.json、应用密码和敏感 Header 值的配置包。
   */
  async exportSafe(): Promise<SafeConfigurationBundle> {
    const models = await createVersionedJsonStore<JsonRecord>(join(this.paths.piDir, "models.json")).read();
    const settings = await createVersionedJsonStore<JsonRecord>(join(this.paths.piDir, "settings.json")).read();
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      files: {
        models: { revision: models.revision, value: scrubSecrets(models.value ?? {}) as JsonRecord },
        settings: { revision: settings.revision, value: scrubSecrets(settings.value ?? {}) as JsonRecord },
        agents: (await this.agents.list()).map(({ profile }) => scrubSecrets(profile)),
      },
    };
  }

  /**
   * 解析标准 Pi JSON 或安全配置包，校验后生成一次性预览。
   *
   * @param input 用户导入的 JSON
   */
  async preview(input: unknown): Promise<ConfigurationImportPreview> {
    const previewId = randomUUID();
    const result: ConfigurationImportPreview = { previewId, added: [], changed: [], conflicts: [], invalid: [] };
    const candidates = parseImport(input, result.invalid);
    const pending: PendingImport = { files: [], blocked: false };

    for (const candidate of candidates) {
      const path = join(this.paths.piDir, `${candidate.name}.json`);
      const current = await createVersionedJsonStore<JsonRecord>(path).read();
      const value = hydrateRedacted(candidate.value, current.value ?? {}) as JsonRecord;
      if (candidate.revision && candidate.revision !== current.revision) result.conflicts.push(candidate.name);
      if (!current.exists) result.added.push(candidate.name);
      else if (stableJson(current.value ?? {}) !== stableJson(value)) result.changed.push(candidate.name);
      if (candidate.name === "models") {
        const validation = await this.validateModels(value);
        if (validation) result.invalid.push({ file: "models", message: validation });
      } else {
        const validation = await this.validateSettings(value);
        if (validation) result.invalid.push({ file: "settings", message: validation });
      }
      pending.files.push({ name: candidate.name, path, expectedRevision: current.revision, value });
    }

    if (candidates.length === 0 && result.invalid.length === 0) result.invalid.push({ file: "bundle", message: "未识别到可导入的 Pi 配置" });
    pending.blocked = result.invalid.length > 0 || result.conflicts.length > 0;
    this.pending.create(previewId, pending);
    return result;
  }

  /**
   * 应用已预览且无错误的候选配置，底层事务再次检查文件 revision。
   *
   * @param previewId 预览标识
   */
  async apply(previewId: string): Promise<ConfigurationApplyResult> {
    const pending = this.pending.consume(previewId);
    if (pending.blocked) throw new TypeError("导入预览包含冲突或无效配置，不能应用");
    for (const file of pending.files) {
      if (file.name === "models") {
        const validation = await this.validateModels(file.value);
        if (validation) throw new TypeError(validation);
      }
    }
    await new ConfigTransaction({ rootDir: this.paths.rootDir, transactionDir: this.paths.transactionDir }).run(
      pending.files.map((file) => ({
        path: file.path,
        expectedRevision: file.expectedRevision,
        nextContent: `${JSON.stringify(file.value, null, 2)}\n`,
        sensitive: false,
      })),
    );
    return { files: pending.files.map((file) => file.name) };
  }

  /** 清理尚未消费的导入预览。 */
  dispose(): void {
    this.pending.clear();
  }

  private async validateModels(value: JsonRecord): Promise<string | undefined> {
    const candidatePath = join(this.paths.piDir, `.models-import-${randomUUID()}.json`);
    const storePath = join(this.paths.piDir, `.models-import-store-${randomUUID()}.json`);
    try {
      await writeJsonAtomic(candidatePath, value);
      const runtime = await ModelRuntime.create({
        modelsPath: candidatePath,
        modelsStorePath: storePath,
        authPath: join(this.paths.piDir, "auth.json"),
        allowModelNetwork: false,
      });
      return runtime.getError() ?? undefined;
    } catch (error) {
      return error instanceof Error ? error.message : "模型配置无法校验";
    } finally {
      await rm(candidatePath, { force: true }).catch(() => undefined);
      await rm(storePath, { force: true }).catch(() => undefined);
    }
  }

  private async validateSettings(value: JsonRecord): Promise<string | undefined> {
    await mkdir(this.paths.transactionDir, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.paths.transactionDir, "settings-import-"));
    const agentDir = join(root, "pi");
    const cwd = join(root, "cwd");
    try {
      await mkdir(agentDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeJsonAtomic(join(agentDir, "settings.json"), value);
      const errors = SettingsManager.create(cwd, agentDir).drainErrors();
      return errors[0]?.error.message;
    } catch (error) {
      return error instanceof Error ? error.message : "设置配置无法校验";
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function parseImport(
  input: unknown,
  invalid: Array<{ file: string; message: string }>,
): Array<{ name: "models" | "settings"; revision?: string; value: JsonRecord }> {
  if (!isRecord(input)) {
    invalid.push({ file: "bundle", message: "导入内容必须是 JSON 对象" });
    return [];
  }
  if (isRecord(input.providers)) return [{ name: "models", value: structuredClone(input) }];
  if (input.version !== 1 || !isRecord(input.files)) {
    invalid.push({ file: "bundle", message: "配置包版本不受支持" });
    return [];
  }
  const files: Array<{ name: "models" | "settings"; revision?: string; value: JsonRecord }> = [];
  for (const name of ["models", "settings"] as const) {
    const document = input.files[name];
    if (!isRecord(document) || !isRecord(document.value)) continue;
    files.push({ name, revision: typeof document.revision === "string" ? document.revision : undefined, value: structuredClone(document.value) });
  }
  return files;
}

export function scrubSecrets(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item));
  if (!isRecord(value)) {
    if (typeof value === "string") return scrubUrl(value);
    return value;
  }
  const result: JsonRecord = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (isSensitiveKey(childKey)) {
      result[childKey] = "[REDACTED]";
      continue;
    }
    if (childKey.toLowerCase() === "headers" && isRecord(childValue)) {
      result[childKey] = Object.fromEntries(Object.keys(childValue).map((header) => [header, "[REDACTED]"]));
      continue;
    }
    result[childKey] = scrubSecrets(childValue, childKey);
  }
  return result;
}

function scrubUrl(value: string): string {
  try {
    const url = new URL(value);
    const sensitiveQuery = [...url.searchParams.keys()].some(isSensitiveKey);
    return url.username || url.password || sensitiveQuery ? "[REDACTED]" : value;
  } catch {
    return value;
  }
}

/**
 * 仅识别约定的凭据字段，避免将 Token 数量等业务字段误判为敏感信息。
 */
const SENSITIVE_FIELD_NAMES = new Set([
  "key",
  "auth",
  "authorization",
  "password",
  "secret",
  "credential",
  "token",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearertoken",
]);

/** 仅遮蔽明确命名的凭据字段，未知配置字段按原值返回。 */
export function isSensitiveKey(value: string): boolean {
  const normalized = value.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return SENSITIVE_FIELD_NAMES.has(normalized);
}

export function hydrateRedacted(candidate: unknown, current: unknown): unknown {
  if (candidate === "[REDACTED]") return structuredClone(current);
  if (Array.isArray(candidate)) return candidate.map((item, index) => hydrateRedacted(item, Array.isArray(current) ? current[index] : undefined));
  if (!isRecord(candidate)) return structuredClone(candidate);
  const currentRecord = isRecord(current) ? current : {};
  return Object.fromEntries(Object.entries(candidate).flatMap(([key, value]) => {
    const hydrated = hydrateRedacted(value, currentRecord[key]);
    return hydrated === undefined ? [] : [[key, hydrated]];
  }));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
