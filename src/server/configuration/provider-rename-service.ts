import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AgentProfile } from "../../shared/agent-contracts";
import type { AgentStore } from "../agents/agent-store";
import type { DataPaths } from "../paths";
import { ConfigTransaction, type ConfigFileChange } from "./config-transaction";
import { ModelConfigService, ProviderAlreadyExistsError, ProviderNotFoundError } from "./model-config-service";
import { VersionConflictError, createVersionedJsonStore, getFileRevision } from "./versioned-json-store";
import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import { readJson, writeJsonAtomic } from "../storage";

type ModelConfigRecord = Record<string, unknown> & { providers?: Record<string, Record<string, unknown>> };
type CredentialRecord = Record<string, Record<string, unknown>>;

interface ProviderRenameManifest {
  version: 1;
  id: string;
  sourceId: string;
  targetId: string;
  agentIds: string[];
  createdAt: string;
}

/**
 * Provider 改名期间的可恢复多文件迁移服务。
 */
export class ProviderRenameService {
  /** Pi 的统一数据路径。 */
  private readonly paths: DataPaths;
  /** 模型配置与候选校验服务。 */
  private readonly models: ModelConfigService;
  /** Agent Profile 存储。 */
  private readonly agents: AgentStore;
  /** 多文件原子提交器。 */
  private readonly transaction: ConfigTransaction;
  private readonly beginRuntimeMaintenance?: () => Promise<{ release(): void }>;
  private readonly refreshModels?: () => Promise<void>;

  /**
   * 创建 Provider 改名服务。
   *
   * @param options 依赖的路径、模型与 Agent 存储
   */
  constructor(options: {
    paths: DataPaths;
    models: ModelConfigService;
    agents: AgentStore;
    transaction?: ConfigTransaction;
    beginRuntimeMaintenance?: () => Promise<{ release(): void }>;
    refreshModels?: () => Promise<void>;
  }) {
    this.paths = options.paths;
    this.models = options.models;
    this.agents = options.agents;
    this.transaction = options.transaction ?? new ConfigTransaction({ rootDir: options.paths.rootDir, transactionDir: options.paths.transactionDir });
    this.beginRuntimeMaintenance = options.beginRuntimeMaintenance;
    this.refreshModels = options.refreshModels;
  }

  /**
   * 将一个 Provider ID 及其所有持久化引用改为新 ID。
   *
   * @param sourceId 现有 Provider ID
   * @param targetId 新 Provider ID
   * @param expectedModelsRevision 浏览器读取到的 models.json 版本
   */
  async rename(sourceId: string, targetId: string, expectedModelsRevision: string) {
    const maintenance = await this.beginRuntimeMaintenance?.();
    try {
    const modelDocument = await this.models.read();
    if (modelDocument.revision !== expectedModelsRevision) {
      throw new VersionConflictError(expectedModelsRevision, modelDocument.revision);
    }
    const providers: Record<string, Record<string, unknown>> = {
      ...((modelDocument.value.providers as Record<string, Record<string, unknown>> | undefined) ?? {}),
    };
    const source = providers[sourceId];
    if (!source) throw new ProviderNotFoundError();
    if (providers[targetId]) throw new ProviderAlreadyExistsError();
    delete providers[sourceId];
    providers[targetId] = source;
    const nextModels: ModelConfigRecord = { ...modelDocument.value, providers };
    await this.models.validateCandidate(nextModels);

    const changes: ConfigFileChange[] = [{
      path: join(this.paths.piDir, "models.json"),
      expectedRevision: modelDocument.revision,
      nextContent: serialize(nextModels),
      sensitive: false,
    }];
    await this.appendCredentialChange(sourceId, targetId, changes);
    const agentChanges = await this.collectAgentChanges(sourceId, targetId);
    if (agentChanges.length > SYSTEM_LIMITS.providerRenameAgents) {
      throw new DomainError("PROVIDER_RENAME_HISTORY_LIMIT", "引用该 Provider 的 Agent 数量超过单次安全迁移上限");
    }
    await this.appendSessionChanges(sourceId, targetId, changes);

    const manifestId = randomUUID();
    const manifestPath = providerRenameManifestPath(this.paths, manifestId);
    const manifest: ProviderRenameManifest = {
      version: 1,
      id: manifestId,
      sourceId,
      targetId,
      agentIds: agentChanges.map((change) => change.before.id),
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(manifestPath, manifest);
    try {
      await this.transaction.execute(changes);
      for (const change of agentChanges) {
        await this.agents.update(change.before.id, { defaultModel: change.after.defaultModel }, change.revision);
      }
      await rm(manifestPath, { force: true });
    } catch (error) {
      try {
        await recoverProviderRenameManifest(this.paths, this.models, this.agents, manifestPath, manifest);
      } catch (recoveryError) {
        // Manifest 必须保留到下次启动；配置事务会先完成自身恢复，再由本 Saga 判定续跑方向。
        throw new DomainError("CONFIG_RECOVERY_REQUIRED", "Provider 改名未完成，系统将在下次启动继续恢复", undefined, {
          cause: new AggregateError([error, recoveryError]),
        });
      }
      const recoveredProviders = (await this.models.read()).value.providers;
      const rolledForward = isRecord(recoveredProviders)
        && isRecord(recoveredProviders[targetId])
        && !isRecord(recoveredProviders[sourceId]);
      if (!rolledForward) throw error;
    }
    const document = await this.models.read();
    try {
      await this.refreshModels?.();
      return document;
    } catch {
      // 持久化改名已提交，Runtime 刷新失败只能作为退化状态返回，不能伪装成可重试的改名失败。
      return {
        ...document,
        diagnostics: [...document.diagnostics, {
          source: "models" as const,
          severity: "warning" as const,
          code: "RUNTIME_REFRESH_REQUIRED",
          message: "Provider 已改名，但 Runtime 刷新失败，请手动刷新配置",
        }],
      };
    }
    } finally {
      maintenance?.release();
    }
  }

  /** 迁移 auth.json 中的完整 Provider 凭证条目。 */
  private async appendCredentialChange(sourceId: string, targetId: string, changes: ConfigFileChange[]): Promise<void> {
    const path = join(this.paths.piDir, "auth.json");
    const loaded = await createVersionedJsonStore<CredentialRecord>(path).read();
    if (!loaded.value?.[sourceId]) return;
    const next = structuredClone(loaded.value);
    next[targetId] = next[sourceId];
    delete next[sourceId];
    changes.push({ path, expectedRevision: loaded.revision, nextContent: serialize(next), sensitive: true });
  }

  /** 迁移引用该 Provider 的 Agent Profile 默认模型。 */
  private async collectAgentChanges(sourceId: string, targetId: string): Promise<Array<{ before: AgentProfile; after: AgentProfile; revision: string }>> {
    const changes: Array<{ before: AgentProfile; after: AgentProfile; revision: string }> = [];
    for (const document of await this.agents.list()) {
      if (document.profile.defaultModel?.provider !== sourceId) continue;
      const next: AgentProfile = {
        ...document.profile,
        defaultModel: { ...document.profile.defaultModel, provider: targetId },
        updatedAt: new Date().toISOString(),
      };
      changes.push({ before: document.profile, after: next, revision: document.revision });
    }
    return changes;
  }

  /** 迁移会话事件中 Pi 可恢复的模型 Provider 引用。 */
  private async appendSessionChanges(sourceId: string, targetId: string, changes: ConfigFileChange[]): Promise<void> {
    let retainedBytes = 0;
    for (const path of await listSessionFiles(join(this.paths.piDir, "sessions"))) {
      const metadata = await stat(path);
      retainedBytes += metadata.size;
      if (retainedBytes > SYSTEM_LIMITS.providerRenameSessionBytes) {
        throw new DomainError("PROVIDER_RENAME_HISTORY_LIMIT", "会话历史过大，无法在安全内存预算内迁移 Provider 引用");
      }
      const content = await readFile(path, "utf8");
      const nextContent = rewriteSessionProviders(content, sourceId, targetId);
      if (nextContent === content) continue;
      const revision = await getFileRevision(path);
      changes.push({ path, expectedRevision: revision, nextContent, sensitive: false });
    }
  }
}

/** 序列化配置文件并统一保留末尾换行。 */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 递归获取 Pi 会话目录中的 JSONL 文件。 */
async function listSessionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [{ path: directory, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    if (current.depth > SYSTEM_LIMITS.workspaceDepth) {
      throw new DomainError("PROVIDER_RENAME_HISTORY_LIMIT", "会话历史目录层级超过系统上限");
    }
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && current.depth === 0) return [];
      throw error;
    }
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) pending.push({ path, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
      if (files.length > SYSTEM_LIMITS.providerRenameSessionFiles) {
        throw new DomainError("PROVIDER_RENAME_HISTORY_LIMIT", "会话历史文件数量超过系统上限");
      }
    }
  }
  return files;
}

/** 启动时恢复尚未完成的 Provider 改名 Saga。 */
export async function recoverPendingProviderRenames(paths: DataPaths, models: ModelConfigService, agents: AgentStore): Promise<void> {
  const directory = providerRenameDirectory(paths);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = await readdir(directory);
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const path = join(directory, file);
    const manifest = await readJson<ProviderRenameManifest>(path);
    if (!isProviderRenameManifest(manifest)) {
      throw new DomainError("CONFIG_RECOVERY_REQUIRED", "Provider 改名恢复清单损坏，已拒绝启动");
    }
    await recoverProviderRenameManifest(paths, models, agents, path, manifest);
  }
}

/** 根据已恢复的 models.json 判定前滚或回退，并幂等协调 Agent 引用。 */
async function recoverProviderRenameManifest(
  paths: DataPaths,
  models: ModelConfigService,
  agents: AgentStore,
  manifestPath: string,
  manifest: ProviderRenameManifest,
): Promise<void> {
  const providers = (await models.read()).value.providers;
  const sourceExists = isRecord(providers) && isRecord(providers[manifest.sourceId]);
  const targetExists = isRecord(providers) && isRecord(providers[manifest.targetId]);
  if (sourceExists === targetExists) {
    throw new DomainError("CONFIG_RECOVERY_REQUIRED", "Provider 改名恢复方向不明确，已拒绝修改 Agent 引用");
  }
  const from = targetExists ? manifest.sourceId : manifest.targetId;
  const to = targetExists ? manifest.targetId : manifest.sourceId;
  for (const agentId of manifest.agentIds) {
    const current = await agents.get(agentId);
    if (!current || current.profile.defaultModel?.provider !== from) continue;
    await agents.update(agentId, {
      defaultModel: { ...current.profile.defaultModel, provider: to },
    }, current.revision);
  }
  await rm(manifestPath, { force: true });
  // 确保空目录只承担 durable Saga 清单职责，不混入其他配置事务文件。
  await mkdir(providerRenameDirectory(paths), { recursive: true, mode: 0o700 });
}

/** 返回 Provider 改名 Saga 的隔离清单目录。 */
function providerRenameDirectory(paths: DataPaths): string {
  return join(paths.transactionDir, "provider-renames");
}

/** 为单次 Provider 改名生成 durable manifest 路径。 */
function providerRenameManifestPath(paths: DataPaths, id: string): string {
  return join(providerRenameDirectory(paths), `${id}.json`);
}

/** 拒绝处理字段不完整或超限的恢复清单。 */
function isProviderRenameManifest(value: unknown): value is ProviderRenameManifest {
  return isRecord(value)
    && value.version === 1
    && typeof value.id === "string"
    && typeof value.sourceId === "string"
    && typeof value.targetId === "string"
    && Array.isArray(value.agentIds)
    && value.agentIds.length <= SYSTEM_LIMITS.providerRenameAgents
    && value.agentIds.every((id) => typeof id === "string")
    && typeof value.createdAt === "string";
}

/** 只转换 Pi 明确的模型事件，其他行保持原始文本。 */
function rewriteSessionProviders(content: string, sourceId: string, targetId: string): string {
  return content.split(/(?<=\n)/u).map((line) => {
    const ending = line.endsWith("\n") ? "\n" : "";
    const raw = ending ? line.slice(0, -1) : line;
    if (!raw) return line;
    try {
      const event = JSON.parse(raw) as Record<string, unknown>;
      let changed = false;
      if (event.type === "model_change" && event.provider === sourceId) {
        event.provider = targetId;
        changed = true;
      }
      if (event.type === "message" && isRecord(event.message) && event.message.provider === sourceId) {
        event.message.provider = targetId;
        changed = true;
      }
      return changed ? `${JSON.stringify(event)}${ending}` : line;
    } catch {
      // 兼容历史或损坏的会话行，改名不应丢失已有记录。
      return line;
    }
  }).join("");
}

/** 判断 JSON 值是否为可安全修改的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
