import { join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import type { ConfigurationDiagnostic, ScopedConfigDocument, WebPiSettings } from "../../shared/configuration-contracts";
import { createVersionedJsonStore } from "./versioned-json-store";
import { hydrateRedacted, scrubSecrets } from "./configuration-operations-service";

/**
 * Pi 设置服务路径。
 */
export interface PiSettingsServiceOptions {
  /**
   * Pi 全局 Agent 配置目录。
   */
  agentDir: string;
  /**
   * Agent 固定工作目录。
   */
  cwd: string;
}

/**
 * 设置变更。
 */
export interface PiSettingsUpdate {
  /**
   * 要深度合并到当前作用域的字段。
   */
  set?: Partial<WebPiSettings>;
  /**
   * 要从 Agent 作用域删除并恢复继承的点路径。
   */
  inherit?: string[];
}

type SettingsRecord = Record<string, unknown>;

const WEB_SETTING_SHAPE: Record<string, true | Record<string, true | Record<string, true>>> = {
  defaultProvider: true,
  defaultModel: true,
  defaultThinkingLevel: true,
  transport: true,
  steeringMode: true,
  followUpMode: true,
  compaction: { enabled: true, reserveTokens: true, keepRecentTokens: true },
  branchSummary: { reserveTokens: true, skipPrompt: true },
  retry: {
    enabled: true,
    maxRetries: true,
    baseDelayMs: true,
    provider: { timeoutMs: true, maxRetries: true, maxRetryDelayMs: true },
  },
  hideThinkingBlock: true,
  thinkingBudgets: { minimal: true, low: true, medium: true, high: true },
  images: { autoResize: true, blockImages: true },
  shellPath: true,
  shellCommandPrefix: true,
  npmCommand: true,
  httpProxy: true,
  httpIdleTimeoutMs: true,
  websocketConnectTimeoutMs: true,
  packages: true,
  extensions: true,
  skills: true,
  prompts: true,
};

const GLOBAL_ONLY_FIELDS = new Set(["httpProxy"]);

/**
 * 判断值是否为可深度合并的普通对象。
 *
 * @param value 待判断值
 */
function isRecord(value: unknown): value is SettingsRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 深度合并设置对象，数组和标量由新值整体替换。
 *
 * @param base 基础值
 * @param override 覆写值
 */
function deepMerge(base: SettingsRecord, override: SettingsRecord): SettingsRecord {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = isRecord(result[key]) && isRecord(value) ? deepMerge(result[key] as SettingsRecord, value) : structuredClone(value);
  }
  return result;
}

/**
 * 按白名单投影 Web 可管理字段。
 *
 * @param source Pi 原始设置
 * @param shape 字段白名单
 */
function projectSettings(source: SettingsRecord, shape = WEB_SETTING_SHAPE): SettingsRecord {
  const projected: SettingsRecord = {};
  for (const [key, childShape] of Object.entries(shape)) {
    const value = source[key];
    if (value === undefined) {
      continue;
    }
    if (childShape === true) {
      projected[key] = structuredClone(value);
    } else if (isRecord(value)) {
      const child = projectSettings(value, childShape);
      if (Object.keys(child).length > 0) {
        projected[key] = child;
      }
    }
  }
  return projected;
}

/**
 * 从对象中删除点路径，并清理空的中间对象。
 *
 * @param target 原始对象
 * @param path 点分隔字段路径
 */
function deletePath(target: SettingsRecord, path: string): void {
  const segments = path.split(".").filter(Boolean);
  const parents: Array<{ object: SettingsRecord; key: string }> = [];
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(current[segment])) {
      return;
    }
    parents.push({ object: current, key: segment });
    current = current[segment] as SettingsRecord;
  }
  const leaf = segments.at(-1);
  if (!leaf) {
    return;
  }
  delete current[leaf];
  for (const { object, key } of parents.reverse()) {
    if (isRecord(object[key]) && Object.keys(object[key] as SettingsRecord).length === 0) {
      delete object[key];
    }
  }
}

/**
 * 以 Pi 原生 settings.json 为唯一事实来源的设置服务。
 */
export class PiSettingsService {
  private readonly agentDir: string;
  private readonly cwd: string;
  private readonly globalFile: string;
  private readonly projectFile: string;

  /**
   * 创建设置服务。
   *
   * @param options Pi 全局目录与 Agent 工作目录
   */
  constructor(options: PiSettingsServiceOptions) {
    this.agentDir = options.agentDir;
    this.cwd = options.cwd;
    this.globalFile = join(options.agentDir, "settings.json");
    this.projectFile = join(options.cwd, ".pi", "settings.json");
  }

  /**
   * 读取全局或 Agent 设置及最终有效值。
   *
   * @param scope 配置作用域
   */
  async read(scope: "global" | "agent"): Promise<ScopedConfigDocument<WebPiSettings>> {
    const manager = SettingsManager.create(this.cwd, this.agentDir);
    const errors = manager.drainErrors();
    const diagnostics: ConfigurationDiagnostic[] = errors.map(({ scope: errorScope, error }) => ({
      source: "settings",
      severity: "error",
      code: "PI_SETTINGS_INVALID",
      message: error.message,
      field: errorScope,
    }));
    const global = scrubSecrets(projectSettings(manager.getGlobalSettings() as SettingsRecord)) as SettingsRecord;
    const project = scrubSecrets(projectSettings(manager.getProjectSettings() as SettingsRecord)) as SettingsRecord;
    const file = scope === "global" ? this.globalFile : this.projectFile;
    const revision = (await createVersionedJsonStore<SettingsRecord>(file).read()).revision;

    if (scope === "global") {
      return {
        revision,
        own: global as Partial<WebPiSettings>,
        effective: global as WebPiSettings,
        diagnostics,
      };
    }
    return {
      revision,
      own: project as Partial<WebPiSettings>,
      inherited: global as Partial<WebPiSettings>,
      effective: deepMerge(global, project) as WebPiSettings,
      diagnostics,
    };
  }

  /**
   * 更新指定作用域，同时原样保留 Web 不认识的 Pi 字段。
   *
   * @param scope 配置作用域
   * @param update 字段设置与继承操作
   * @param expectedRevision 调用方读取到的文件版本
   */
  async update(
    scope: "global" | "agent",
    update: PiSettingsUpdate,
    expectedRevision: string,
  ): Promise<ScopedConfigDocument<WebPiSettings>> {
    if (scope === "agent" && Object.keys(update.set ?? {}).some((key) => GLOBAL_ONLY_FIELDS.has(key))) {
      throw new TypeError("该设置只能在全局作用域修改");
    }
    const file = scope === "global" ? this.globalFile : this.projectFile;
    const store = createVersionedJsonStore<SettingsRecord>(file);
    const loaded = await store.read();
    const current = loaded.value ?? {};
    const hydratedSet = hydrateRedacted(update.set ?? {}, current) as SettingsRecord;
    const next = deepMerge(current, hydratedSet);
    for (const path of update.inherit ?? []) {
      deletePath(next, path);
    }
    await this.validateCandidate(scope, next);
    await store.write(next, expectedRevision);
    return this.read(scope);
  }

  /** 在数据卷内的隔离目录验证候选设置，正式文件始终保持最后一个有效版本。 */
  private async validateCandidate(scope: "global" | "agent", candidate: SettingsRecord): Promise<void> {
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    const validationRoot = await mkdtemp(join(this.agentDir, ".bugpaw-settings-validation-"));
    const agentDir = join(validationRoot, "pi");
    const cwd = join(validationRoot, "workspace");
    await mkdir(join(cwd, ".pi"), { recursive: true, mode: 0o700 });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    try {
      const global = scope === "global" ? candidate : await readSettingsFile(this.globalFile);
      const project = scope === "agent" ? candidate : await readSettingsFile(this.projectFile);
      await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(global)}\n`, { mode: 0o600 });
      await writeFile(join(cwd, ".pi", "settings.json"), `${JSON.stringify(project)}\n`, { mode: 0o600 });
      const manager = SettingsManager.create(cwd, agentDir);
      if (manager.drainErrors().length > 0) throw new TypeError("Pi 无法读取候选设置");
    } finally {
      await rm(validationRoot, { recursive: true, force: true });
    }
  }
}

async function readSettingsFile(path: string): Promise<SettingsRecord> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SettingsRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
