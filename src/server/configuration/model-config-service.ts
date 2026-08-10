import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ConfigurationDiagnostic, ModelConfigDocument } from "../../shared/configuration-contracts";
import { writeJsonAtomic } from "../storage";
import { createVersionedJsonStore } from "./versioned-json-store";

/**
 * 模型配置服务路径。
 */
export interface ModelConfigServiceOptions {
  /**
   * Pi 原生 models.json 路径。
   */
  modelsPath: string;
  /**
   * Pi 原生 auth.json 路径。
   */
  authPath: string;
}

/**
 * 模型候选配置未通过 Pi 原生校验。
 */
export class ModelConfigurationValidationError extends Error {
  /**
   * 结构化字段诊断。
   */
  readonly diagnostics: ConfigurationDiagnostic[];

  /**
   * 创建模型配置校验错误。
   *
   * @param diagnostics Pi 原生校验诊断
   */
  constructor(diagnostics: ConfigurationDiagnostic[]) {
    super("模型配置未通过 Pi 校验");
    this.name = "ModelConfigurationValidationError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Provider ID 已被既有配置占用。
 */
export class ProviderAlreadyExistsError extends Error {
  constructor() {
    super("Provider ID 已存在");
    this.name = "ProviderAlreadyExistsError";
  }
}

/**
 * Provider ID 不存在，无法执行目标操作。
 */
export class ProviderNotFoundError extends Error {
  constructor() {
    super("Provider 不存在");
    this.name = "ProviderNotFoundError";
  }
}

type ModelConfigRecord = Record<string, unknown> & { providers?: Record<string, Record<string, unknown>> };

/**
 * 按用户指定顺序重建记录键，并将未收录项保持原有相对顺序追加。
 */
function reorderRecord(
  source: Record<string, Record<string, unknown>>,
  ids: string[],
  label: string,
): Record<string, Record<string, unknown>> {
  if (new Set(ids).size !== ids.length || ids.some((id) => !source[id])) {
    throw new TypeError(`${label} 排序包含无效 ID`);
  }
  const ordered = ids.map((id) => [id, source[id]] as const);
  const included = new Set(ids);
  return Object.fromEntries([
    ...ordered,
    ...Object.entries(source).filter(([id]) => !included.has(id)),
  ]);
}

/**
 * 把 Pi ModelRuntime 错误转换为字段诊断。
 *
 * @param message Pi 原始错误
 */
function modelDiagnostics(message: string): ConfigurationDiagnostic[] {
  const detailLines = message.split("\n").filter((line) => line.trim().startsWith("-"));
  if (detailLines.length === 0) {
    return [{ source: "models", severity: "error", code: "PI_MODELS_INVALID", message }];
  }
  return detailLines.map((line) => {
    const detail = line.trim().replace(/^-\s*/u, "");
    const separator = detail.indexOf(":");
    return {
      source: "models",
      severity: "error",
      code: "PI_MODELS_SCHEMA_INVALID",
      message: separator >= 0 ? detail.slice(separator + 1).trim() : detail,
      field: separator >= 0 ? detail.slice(0, separator).trim() : undefined,
    };
  });
}

/**
 * 以 models.json 为唯一事实来源的保留式模型配置服务。
 */
export class ModelConfigService {
  private readonly modelsPath: string;
  private readonly authPath: string;

  /**
   * 创建模型配置服务。
   *
   * @param options models.json 与 auth.json 路径
   */
  constructor(options: ModelConfigServiceOptions) {
    this.modelsPath = options.modelsPath;
    this.authPath = options.authPath;
  }

  /**
   * 读取保留未知字段的原始模型配置。
   */
  async read(): Promise<ModelConfigDocument> {
    const loaded = await createVersionedJsonStore<ModelConfigRecord>(this.modelsPath).read();
    const value = loaded.value ?? { providers: {} };
    return { revision: loaded.revision, value, diagnostics: [] };
  }

  /**
   * 更新单个 Provider 节点。
   *
   * @param providerId Provider 标识
   * @param patch 节点字段变更
   * @param revision 调用方文件版本
   */
  async updateProvider(
    providerId: string,
    patch: Record<string, unknown>,
    revision: string,
  ): Promise<ModelConfigDocument> {
    return this.mutate(revision, (config) => {
      const providers = { ...(config.providers ?? {}) };
      if (!providers[providerId]) throw new ProviderNotFoundError();
      providers[providerId] = { ...providers[providerId], ...structuredClone(patch) };
      return { ...config, providers };
    });
  }

  /**
   * 创建一个此前不存在的 Provider 节点。
   *
   * @param providerId 用户指定的稳定 Provider 标识
   * @param provider 完整 Provider 配置
   * @param revision 调用方文件版本
   */
  async createProvider(providerId: string, provider: Record<string, unknown>, revision: string): Promise<ModelConfigDocument> {
    return this.mutate(revision, (config) => {
      const providers = { ...(config.providers ?? {}) };
      if (providers[providerId]) throw new ProviderAlreadyExistsError();
      providers[providerId] = structuredClone(provider);
      return { ...config, providers };
    });
  }

  /**
   * 重排 Pi 原生 Provider 对象的键顺序。
   *
   * @param providerIds 用户指定的 Provider ID 顺序
   * @param revision 调用方文件版本
   */
  async reorderProviders(providerIds: string[], revision: string): Promise<ModelConfigDocument> {
    return this.mutate(revision, (config) => ({
      ...config,
      providers: reorderRecord(config.providers ?? {}, providerIds, "Provider"),
    }));
  }

  /**
   * 删除单个 Provider 节点。
   *
   * @param providerId Provider 标识
   * @param revision 调用方文件版本
   */
  async removeProvider(providerId: string, revision: string): Promise<ModelConfigDocument> {
    return this.mutate(revision, (config) => {
      const providers = { ...(config.providers ?? {}) };
      if (!providers[providerId]) throw new ProviderNotFoundError();
      delete providers[providerId];
      return { ...config, providers };
    });
  }

  /**
   * 更新 Provider 下单个模型节点。
   *
   * @param providerId Provider 标识
   * @param modelId 模型标识
   * @param patch 模型字段变更
   * @param revision 调用方文件版本
   */
  async updateModel(
    providerId: string,
    modelId: string,
    patch: Record<string, unknown>,
    revision: string,
  ): Promise<ModelConfigDocument> {
    return this.mutate(revision, (config) => {
      const providers = { ...(config.providers ?? {}) };
      if (!providers[providerId]) throw new ProviderNotFoundError();
      const provider = { ...(providers[providerId] ?? {}) };
      const models = Array.isArray(provider.models) ? provider.models.map((model) => structuredClone(model)) : [];
      const index = models.findIndex((model) => {
        return typeof model === "object" && model !== null && (model as Record<string, unknown>).id === modelId;
      });
      if (index < 0) {
        throw new TypeError("目标模型不存在");
      }
      models[index] = { ...(models[index] as Record<string, unknown>), ...structuredClone(patch), id: modelId };
      providers[providerId] = { ...provider, models };
      return { ...config, providers };
    });
  }

  /**
   * 新建或完整更新 Provider 下的单个模型节点。
   */
  async upsertModel(
    providerId: string,
    modelId: string,
    model: Record<string, unknown>,
    revision: string,
  ): Promise<ModelConfigDocument> {
    return this.mutate(revision, (config) => {
      const providers = { ...(config.providers ?? {}) };
      if (!providers[providerId]) throw new ProviderNotFoundError();
      const provider = { ...(providers[providerId] ?? {}) };
      const models = Array.isArray(provider.models) ? provider.models.map((item) => structuredClone(item)) : [];
      const index = models.findIndex((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).id === modelId);
      const nextModel = { ...structuredClone(model), id: modelId };
      if (index >= 0) models[index] = nextModel;
      else models.push(nextModel);
      providers[providerId] = { ...provider, models };
      return { ...config, providers };
    });
  }

  /**
   * 重排指定 Provider 内 Pi 原生 models 数组的元素顺序。
   *
   * @param providerId Provider 标识
   * @param modelIds 用户指定的模型 ID 顺序
   * @param revision 调用方文件版本
   */
  async reorderModels(providerId: string, modelIds: string[], revision: string): Promise<ModelConfigDocument> {
    return this.mutate(revision, (config) => {
      const providers = { ...(config.providers ?? {}) };
      const provider = providers[providerId];
      if (!provider) throw new ProviderNotFoundError();
      const models = Array.isArray(provider.models) ? provider.models.map((model) => structuredClone(model)) : [];
      const modelsById = new Map<string, unknown>();
      for (const model of models) {
        if (typeof model !== "object" || model === null || typeof (model as Record<string, unknown>).id !== "string") {
          throw new TypeError("模型配置缺少有效 ID");
        }
        modelsById.set((model as Record<string, string>).id, model);
      }
      if (new Set(modelIds).size !== modelIds.length || modelIds.some((modelId) => !modelsById.has(modelId))) {
        throw new TypeError("模型排序包含无效 ID");
      }
      const ordered = modelIds.map((modelId) => modelsById.get(modelId)!);
      const included = new Set(modelIds);
      providers[providerId] = {
        ...provider,
        models: [...ordered, ...models.filter((model) => !included.has((model as Record<string, string>).id))],
      };
      return { ...config, providers };
    });
  }

  /**
   * 删除 Provider 下的单个模型节点。
   */
  async removeModel(providerId: string, modelId: string, revision: string): Promise<ModelConfigDocument> {
    return this.mutate(revision, (config) => {
      const providers = { ...(config.providers ?? {}) };
      if (!providers[providerId]) throw new ProviderNotFoundError();
      const provider = { ...(providers[providerId] ?? {}) };
      const models = Array.isArray(provider.models)
        ? provider.models.filter((item) => !(typeof item === "object" && item !== null && (item as Record<string, unknown>).id === modelId))
        : [];
      providers[providerId] = { ...provider, models };
      return { ...config, providers };
    });
  }

  /**
   * 在候选文件通过 Pi 原生 ModelRuntime 校验后提交变更。
   *
   * @param revision 调用方文件版本
   * @param mutation 目标节点变更函数
   */
  private async mutate(
    revision: string,
    mutation: (config: ModelConfigRecord) => ModelConfigRecord,
  ): Promise<ModelConfigDocument> {
    const store = createVersionedJsonStore<ModelConfigRecord>(this.modelsPath);
    const loaded = await store.read();
    const candidate = mutation(structuredClone(loaded.value ?? { providers: {} }));
    await this.validateCandidate(candidate);
    await store.write(candidate, revision);
    return this.read();
  }

  /**
   * 用 Pi 原生运行时校验完整候选模型配置，不写入正式文件。
   *
   * @param candidate 待提交的完整 models.json 内容
   */
  async validateCandidate(candidate: ModelConfigRecord): Promise<void> {
    const candidatePath = join(dirname(this.modelsPath), `.models-candidate-${randomUUID()}.json`);
    const candidateStorePath = join(dirname(this.modelsPath), `.models-store-candidate-${randomUUID()}.json`);
    try {
      await writeJsonAtomic(candidatePath, candidate);
      const runtime = await ModelRuntime.create({
        modelsPath: candidatePath,
        modelsStorePath: candidateStorePath,
        authPath: this.authPath,
        allowModelNetwork: false,
      });
      const error = runtime.getError();
      if (error) throw new ModelConfigurationValidationError(modelDiagnostics(error));
    } finally {
      await rm(candidatePath, { force: true }).catch(() => undefined);
      await rm(candidateStorePath, { force: true }).catch(() => undefined);
    }
  }
}
