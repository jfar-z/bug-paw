import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ModelSummary } from "./pi-runtime";
import type { RuntimeSupervisor } from "./runtime/runtime-supervisor";

/**
 * 模型连接测试请求。
 */
export type ModelConnectionTestRequest =
  | { scope: "current"; modelId: string }
  | { scope: "all" };

/**
 * 单个模型连接测试结果。
 */
export interface ModelConnectionTestItem {
  modelId: string;
  modelName: string;
  ok: boolean;
  durationMs: number;
  responsePreview?: string;
  errorCode?: string;
  message?: string;
}

/**
 * Provider 连接测试结果。
 */
export interface ModelConnectionTestResult {
  providerId: string;
  results: ModelConnectionTestItem[];
}

/**
 * 连接测试可预期的业务错误。
 */
export class ModelConnectionTestError extends Error {
  /**
   * 创建连接测试错误。
   *
   * @param code 稳定错误码
   * @param message 面向调用方的安全消息
   */
  constructor(
    readonly code: "PROVIDER_NOT_FOUND" | "MODEL_NOT_FOUND" | "MODEL_TEST_IN_PROGRESS",
    message: string,
  ) {
    super(message);
    this.name = "ModelConnectionTestError";
  }
}

/**
 * 全局 Pi 配置刷新可预期的业务错误。
 */
export class RuntimeRefreshError extends Error {
  constructor(
    readonly code: "REFRESH_IN_PROGRESS",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeRefreshError";
  }
}

/**
 * Runtime 协调器依赖。
 */
export interface RuntimeCoordinatorOptions {
  modelRuntime: ModelRuntime;
  runtimeSupervisor: Pick<RuntimeSupervisor, "refreshModels" | "replaceModelRuntime" | "refreshAgent" | "refreshAllAgents" | "abortAll" | "removeAgent" | "finalizeAgentRemoval" | "restoreAgent" | "drainAndDispose">;
  recreateModelRuntime?: () => Promise<ModelRuntime>;
  onModelRuntimeReplaced?: (modelRuntime: ModelRuntime) => void;
}

/**
 * 模型目录和 Agent Runtime 生命周期的统一协调接口。
 */
export interface RuntimeCoordinator {
  listModels(): Promise<ModelSummary[]>;
  refreshModels(): Promise<void>;
  refreshAgent(agentId: string): Promise<void>;
  refreshAllAgents(): Promise<void>;
  refreshRuntime(): Promise<{ abortedSessions: number }>;
  removeAgent(agentId: string): Promise<void>;
  finalizeAgentRemoval(agentId: string): void;
  restoreAgent(agentId: string): void;
  testModels(providerId: string, request: ModelConnectionTestRequest): Promise<ModelConnectionTestResult>;
  dispose(): Promise<void>;
}

type RuntimeModel = ReturnType<ModelRuntime["getModels"]>[number];
type AssistantResponse = Awaited<ReturnType<ModelRuntime["completeSimple"]>>;

/**
 * 创建共享模型目录和 Agent Runtime 的协调器。
 *
 * @param options 共享模型运行时与 Agent Runtime 管理器
 */
export function createRuntimeCoordinator(options: RuntimeCoordinatorOptions): RuntimeCoordinator {
  const testingProviders = new Set<string>();
  let refreshing = false;
  let modelRuntime = options.modelRuntime;

  /**
   * 重建模型目录，兼容 Pi Runtime 无法通过 refresh 识别 Provider ID 改名的限制。
   */
  async function refreshModelRuntime(): Promise<void> {
    if (!options.recreateModelRuntime) {
      await modelRuntime.refresh({ allowNetwork: false });
      await options.runtimeSupervisor.refreshAllAgents();
      return;
    }
    const nextModelRuntime = await options.recreateModelRuntime();
    await options.runtimeSupervisor.replaceModelRuntime(nextModelRuntime);
    modelRuntime = nextModelRuntime;
    options.onModelRuntimeReplaced?.(nextModelRuntime);
  }

  async function testOne(model: RuntimeModel): Promise<ModelConnectionTestItem> {
    const startedAt = Date.now();
    const controller = new AbortController();
    try {
      const response = await withTimeout(
        modelRuntime.completeSimple(model, {
          messages: [{ role: "user", content: "只回复 OK", timestamp: Date.now() }],
        }, {
          reasoning: "off",
          maxTokens: 8,
          maxRetries: 0,
          timeoutMs: 20_000,
          signal: controller.signal,
        } as unknown as Parameters<ModelRuntime["completeSimple"]>[2]),
        controller,
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        return failedResult(model, startedAt, failureMessage(response.errorMessage));
      }
      return {
        modelId: model.id,
        modelName: model.name,
        ok: true,
        durationMs: Date.now() - startedAt,
        responsePreview: responsePreview(response),
      };
    } catch (error) {
      if (error instanceof ModelTestTimeoutError) {
        return failedResult(model, startedAt, "模型请求超时", "MODEL_TEST_TIMEOUT");
      }
      return failedResult(model, startedAt, failureMessage(error instanceof Error ? error.message : undefined));
    }
  }

  return {
    async listModels() {
      const models = await modelRuntime.getAvailable();
      return models.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
    },

    async refreshModels() {
      await refreshModelRuntime();
    },

    refreshAgent: (agentId) => options.runtimeSupervisor.refreshAgent(agentId),

    refreshAllAgents: () => options.runtimeSupervisor.refreshAllAgents(),

    async refreshRuntime() {
      if (refreshing) {
        throw new RuntimeRefreshError("REFRESH_IN_PROGRESS", "Pi 配置刷新正在进行");
      }
      refreshing = true;
      try {
        const abortedSessions = await options.runtimeSupervisor.abortAll();
        await refreshModelRuntime();
        return { abortedSessions };
      } finally {
        refreshing = false;
      }
    },

    removeAgent: (agentId) => options.runtimeSupervisor.removeAgent(agentId),

    finalizeAgentRemoval: (agentId) => options.runtimeSupervisor.finalizeAgentRemoval(agentId),

    restoreAgent: (agentId) => options.runtimeSupervisor.restoreAgent(agentId),

    async testModels(providerId, request) {
      if (testingProviders.has(providerId)) {
        throw new ModelConnectionTestError("MODEL_TEST_IN_PROGRESS", "该 Provider 正在测试中");
      }
      testingProviders.add(providerId);
      try {
        await modelRuntime.refresh({ allowNetwork: false });
        if (!modelRuntime.getProvider(providerId)) {
          throw new ModelConnectionTestError("PROVIDER_NOT_FOUND", "Provider 不存在");
        }
        const registered = modelRuntime.getModels(providerId);
        const models = request.scope === "all"
          ? registered
          : registered.filter((model) => model.id === request.modelId);
        if (request.scope === "current" && models.length === 0) {
          throw new ModelConnectionTestError("MODEL_NOT_FOUND", "模型不存在");
        }
        const results: ModelConnectionTestItem[] = [];
        for (const model of models) {
          results.push(await testOne(model));
        }
        return { providerId, results };
      } finally {
        testingProviders.delete(providerId);
      }
    },

    async dispose() {
      await options.runtimeSupervisor.drainAndDispose();
    },
  };
}

/**
 * 创建失败的测试结果。
 *
 * @param model 被测试模型
 * @param startedAt 开始时间戳
 * @param message 安全错误消息
 * @param errorCode 可选稳定错误码
 */
function failedResult(
  model: RuntimeModel,
  startedAt: number,
  message: string,
  errorCode?: string,
): ModelConnectionTestItem {
  return {
    modelId: model.id,
    modelName: model.name,
    ok: false,
    durationMs: Date.now() - startedAt,
    ...(errorCode ? { errorCode } : {}),
    message,
  };
}

/**
 * 从 Assistant 响应提取短文本预览。
 *
 * @param response Pi Assistant 响应
 */
function responsePreview(response: AssistantResponse): string | undefined {
  const text = response.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") return undefined;
  // 连接测试只要求固定回复 OK；任何其他远端文本都可能是 Provider 对请求凭证的恶意回显。
  return text.text.trim().toUpperCase() === "OK" ? "OK" : undefined;
}

/**
 * 生成便于定位连接问题且不会泄露凭证的错误摘要。
 */
function failureMessage(_value: string | undefined): string {
  // 底层错误可能裸回显实际请求凭证，模式清洗无法给出绝对不泄露保证。
  return "模型请求失败";
}

class ModelTestTimeoutError extends Error {
  constructor() {
    super("模型请求超时");
  }
}

/**
 * 为不遵守 Provider timeout 参数的实现提供硬截止。
 *
 * @param operation Pi 请求 Promise
 * @param controller 请求取消控制器
 */
function withTimeout<T>(operation: Promise<T>, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new ModelTestTimeoutError());
    }, 22_000);
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
