import { open } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SYSTEM_LIMITS } from "../core/limits";
import { DomainError } from "../core/errors";

export type ResourceType = "skill" | "prompt" | "extension" | "theme";
export interface ResourceCatalogItem {
  id: string;
  type: ResourceType;
  name: string;
  description: string;
  path: string;
  source: string;
  scope: "global" | "agent";
  origin: "package" | "top-level";
  enabled: boolean;
  inherited: boolean;
}
export interface ResourceToolItem { name: string; description: string; extensionPath: string; highRisk: boolean }
export interface ResourceCatalog {
  resources: ResourceCatalogItem[];
  tools: ResourceToolItem[];
  diagnostics: Array<{ type: string; message: string; path?: string }>;
  packages: Array<{ source: string; scope: "user" | "project"; filtered: boolean; installedPath?: string }>;
}

export type ConfigurationTaskEvent =
  | { type: "started"; taskId: string; label: string }
  | { type: "log"; taskId: string; line: string }
  | { type: "completed"; taskId: string }
  | { type: "failed"; taskId: string; code: string; message: string };

/**
 * 保存短期任务事件并向 SSE 订阅者广播，所有日志先做凭证脱敏。
 */
export class ResourceTaskManager {
  private readonly events = new Map<string, ConfigurationTaskEvent[]>();
  private readonly listeners = new Map<string, Set<(event: ConfigurationTaskEvent) => void>>();
  private readonly createdAt = new Map<string, number>();
  private readonly terminal = new Set<string>();
  private readonly executions = new Set<Promise<void>>();
  private closing = false;

  constructor(private readonly maxTasks: number = SYSTEM_LIMITS.resourceTasks) {}

  start(
    label: string,
    action: (log: (line: string) => void) => Promise<void>,
    onCompleted?: () => Promise<void>,
  ): string {
    if (this.closing) throw new DomainError("OPERATION_ABORTED", "服务正在关闭，不能启动资源任务");
    this.prune();
    this.ensureCapacity();
    const taskId = randomUUID();
    this.events.set(taskId, []);
    this.createdAt.set(taskId, Date.now());
    const emit = (event: ConfigurationTaskEvent) => {
      if (event.type === "log" && this.terminal.has(taskId)) return;
      const history = this.events.get(taskId);
      if (!history) return;
      history.push(event);
      if (event.type === "log") {
        let logIndexes = history.flatMap((item, index) => item.type === "log" ? [index] : []);
        let logBytes = history.reduce((total, item) => total + (item.type === "log" ? Buffer.byteLength(item.line) : 0), 0);
        while (logIndexes.length > SYSTEM_LIMITS.resourceLogLinesPerTask || logBytes > SYSTEM_LIMITS.resourceLogBytesPerTask) {
          const index = logIndexes[0];
          if (index === undefined) break;
          const removed = history[index];
          if (removed?.type === "log") logBytes -= Buffer.byteLength(removed.line);
          history.splice(index, 1);
          logIndexes = history.flatMap((item, nextIndex) => item.type === "log" ? [nextIndex] : []);
        }
      } else if (event.type === "completed" || event.type === "failed") {
        this.terminal.add(taskId);
      }
      this.listeners.get(taskId)?.forEach((listener) => listener(event));
    };
    emit({ type: "started", taskId, label: sanitizeLog(label) });
    const execution = action((line) => emit({ type: "log", taskId, line: sanitizeLog(line) }))
      .then(async () => onCompleted?.())
      .then(() => emit({ type: "completed", taskId }))
      .catch((error: unknown) => emit({ type: "failed", taskId, code: "RESOURCE_TASK_FAILED", message: sanitizeLog(error instanceof Error ? error.message : "资源任务失败") }));
    this.executions.add(execution);
    void execution.finally(() => this.executions.delete(execution));
    return taskId;
  }

  /** 停止接收新任务并在统一预算内等待所有包管理写操作结束。 */
  async stopAndDrain(timeoutMs?: number): Promise<boolean> {
    this.closing = true;
    const drained = Promise.allSettled([...this.executions]).then(() => true);
    if (timeoutMs === undefined) return drained;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      drained,
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    return result;
  }

  history(taskId: string): ConfigurationTaskEvent[] | undefined {
    this.prune();
    return this.events.get(taskId);
  }
  subscribe(taskId: string, listener: (event: ConfigurationTaskEvent) => void): () => void {
    this.prune();
    const listeners = this.listeners.get(taskId) ?? new Set(); listeners.add(listener); this.listeners.set(taskId, listeners);
    return () => listeners.delete(listener);
  }

  private prune(): void {
    const cutoff = Date.now() - SYSTEM_LIMITS.resourceLogTtlMs;
    for (const [taskId, createdAt] of this.createdAt) {
      if (createdAt >= cutoff || !this.terminal.has(taskId)) continue;
      this.remove(taskId);
    }
  }

  private ensureCapacity(): void {
    while (this.events.size >= this.maxTasks) {
      const oldestTerminal = [...this.createdAt.entries()]
        .filter(([taskId]) => this.terminal.has(taskId))
        .sort((left, right) => left[1] - right[1])[0]?.[0];
      if (!oldestTerminal) {
        throw new DomainError("OPERATION_ABORTED", "资源任务并发数量已达到上限，请稍后重试");
      }
      this.remove(oldestTerminal);
    }
  }

  private remove(taskId: string): void {
    this.createdAt.delete(taskId);
    this.events.delete(taskId);
    this.listeners.delete(taskId);
    this.terminal.delete(taskId);
  }
}

/**
 * 创建使用 Pi 原生包管理器的安装动作；只有安装成功后才持久化来源。
 */
export function createPackageInstallAction(options: { agentDir: string; cwd: string; source: string; local: boolean }) {
  return async (log: (line: string) => void) => {
    const settings = SettingsManager.create(options.cwd, options.agentDir);
    const manager = new DefaultPackageManager({ cwd: options.cwd, agentDir: options.agentDir, settingsManager: settings });
    manager.setProgressCallback((event) => log(event.message ?? `${event.action}: ${event.source}`));
    await manager.installAndPersist(options.source, { local: options.local });
  };
}

export function createPackageRemoveAction(options: { agentDir: string; cwd: string; source: string; local: boolean }) {
  return async (log: (line: string) => void) => {
    const settings = SettingsManager.create(options.cwd, options.agentDir);
    const manager = new DefaultPackageManager({ cwd: options.cwd, agentDir: options.agentDir, settingsManager: settings });
    manager.setProgressCallback((event) => log(event.message ?? `${event.action}: ${event.source}`));
    await manager.removeAndPersist(options.source, { local: options.local });
  };
}

function sanitizeLog(line: string): string {
  const sanitized = line
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/giu, "$1***:***@")
    .replace(/((?:api[_-]?key|token|secret|authorization)\s*[=:]\s*)\S+/giu, "$1***")
    .replace(/(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{8,}/gu, "***");
  return truncateUtf8(sanitized, SYSTEM_LIMITS.resourceLogLineBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes - 3) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}...`;
}

/**
 * 使用 Pi DefaultResourceLoader 构建不重复保存状态的资源目录。
 */
export class ResourceService {
  constructor(private readonly options: { agentDir: string; cwd: string }) {}

  async catalog(): Promise<ResourceCatalog> {
    const loader = new DefaultResourceLoader(this.options);
    await loader.reload({ resolveProjectTrust: async () => true });
    const skills = loader.getSkills(); const prompts = loader.getPrompts(); const extensions = loader.getExtensions(); const themes = loader.getThemes();
    const resources: ResourceCatalogItem[] = [];
    const add = (type: ResourceType, name: string, description: string, path: string, sourceInfo: { source: string; scope: string; origin: "package" | "top-level" }) => {
      resources.push({ id: `${type}:${path}`, type, name, description, path, source: sourceInfo.source, scope: sourceInfo.scope === "project" ? "agent" : "global", origin: sourceInfo.origin, enabled: true, inherited: sourceInfo.scope === "user" });
    };
    for (const skill of skills.skills) add("skill", skill.name, skill.description, skill.filePath, skill.sourceInfo);
    for (const prompt of prompts.prompts) add("prompt", prompt.name, prompt.description, prompt.filePath, prompt.sourceInfo);
    for (const extension of extensions.extensions) add("extension", basename(extension.path), "Pi 扩展", extension.path, extension.sourceInfo);
    for (const theme of themes.themes) {
      const sourceInfo = (theme as unknown as { sourceInfo?: { source: string; scope: string; origin: "package" | "top-level" }; path?: string; name?: string }).sourceInfo;
      const path = (theme as unknown as { path?: string }).path;
      if (sourceInfo && path) add("theme", (theme as unknown as { name?: string }).name ?? basename(path), "主题", path, sourceInfo);
    }
    const settings = SettingsManager.create(this.options.cwd, this.options.agentDir);
    const packageManager = new DefaultPackageManager({ ...this.options, settingsManager: settings });
    const resolved = await packageManager.resolve(async () => "skip");
    for (const [type, entries] of Object.entries(resolved) as Array<[ResourceType extends infer _ ? string : never, typeof resolved.skills]>) {
      const resourceType = type === "skills" ? "skill" : type === "prompts" ? "prompt" : type === "extensions" ? "extension" : "theme";
      for (const entry of entries) {
        const existing = resources.find((item) => item.path === entry.path && item.type === resourceType);
        if (existing) existing.enabled = entry.enabled;
        else resources.push({ id: `${resourceType}:${entry.path}`, type: resourceType, name: basename(entry.path), description: "已配置但当前未加载", path: entry.path, source: entry.metadata.source, scope: entry.metadata.scope === "project" ? "agent" : "global", origin: entry.metadata.origin, enabled: entry.enabled, inherited: entry.metadata.scope === "user" });
      }
    }
    const tools = extensions.extensions.flatMap((extension) => [...extension.tools.values()].map((tool) => ({ name: tool.definition.name, description: tool.definition.description ?? "", extensionPath: extension.path, highRisk: true })));
    return { resources, tools, packages: packageManager.listConfiguredPackages(), diagnostics: [...skills.diagnostics, ...prompts.diagnostics, ...themes.diagnostics, ...extensions.errors.map((error) => ({ type: "error", message: error.error, path: error.path }))] };
  }

  async readContent(resourceId: string): Promise<string> {
    const item = (await this.catalog()).resources.find((resource) => resource.id === resourceId);
    if (!item) throw new Error("资源不存在");
    return readUtf8Prefix(item.path, 256 * 1024);
  }

  /**
   * 通过 Pi 原生 +path/-path 表达启用、屏蔽或恢复继承。
   */
  async setMode(resourceId: string, mode: "enabled" | "disabled" | "inherit", target: "global" | "agent"): Promise<ResourceCatalog> {
    const item = (await this.catalog()).resources.find((resource) => resource.id === resourceId);
    if (!item) throw new Error("资源不存在");
    const settings = SettingsManager.create(this.options.cwd, this.options.agentDir);
    const key = `${item.type}s` as "extensions" | "skills" | "prompts" | "themes";
    const currentSettings = target === "agent" ? settings.getProjectSettings() : settings.getGlobalSettings();
    const current = [...((currentSettings[key] as string[] | undefined) ?? [])];
    const normalized = current.filter((entry) => entry.replace(/^[+!-]/u, "") !== item.path);
    if (mode !== "inherit") normalized.push(item.path, `${mode === "enabled" ? "+" : "-"}${item.path}`);
    if (target === "agent") setProjectPaths(settings, key, normalized); else setGlobalPaths(settings, key, normalized);
    return this.catalog();
  }
}

/** 有界读取资源文本，避免损坏 package 中的超大文件拖垮管理页。 */
async function readUtf8Prefix(path: string, limit: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const prefix = buffer.subarray(0, Math.min(offset, limit));
    const attempts = offset > limit ? 4 : 1;
    for (let trim = 0; trim < attempts && trim <= prefix.byteLength; trim += 1) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(trim === 0 ? prefix : prefix.subarray(0, prefix.byteLength - trim));
      } catch {
        // 截断可能落在多字节字符中间，最多回退三个字节。
      }
    }
    throw new TypeError("资源文件不是 UTF-8 文本");
  } finally {
    await handle.close();
  }
}

function setGlobalPaths(settings: SettingsManager, key: "extensions" | "skills" | "prompts" | "themes", paths: string[]) {
  if (key === "extensions") settings.setExtensionPaths(paths); else if (key === "skills") settings.setSkillPaths(paths); else if (key === "prompts") settings.setPromptTemplatePaths(paths); else settings.setThemePaths(paths);
}
function setProjectPaths(settings: SettingsManager, key: "extensions" | "skills" | "prompts" | "themes", paths: string[]) {
  if (key === "extensions") settings.setProjectExtensionPaths(paths); else if (key === "skills") settings.setProjectSkillPaths(paths); else if (key === "prompts") settings.setProjectPromptTemplatePaths(paths); else settings.setProjectThemePaths(paths);
}
