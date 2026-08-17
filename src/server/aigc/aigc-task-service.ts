import { randomUUID } from "node:crypto";

import type {
  AigcRunRequest,
  AigcTaskDocument,
  AigcTaskError,
  AigcTaskExecutionState,
  AigcTaskRecord,
  AigcTaskSummary,
} from "../../shared/aigc-contracts";
import type { CredentialService } from "../configuration/credential-service";
import { AigcAssetService } from "./aigc-asset-service";
import type { AigcConnectionService } from "./aigc-connection-service";
import type { AigcInterfaceService } from "./aigc-interface-service";
import type { AigcProtocolAdapter } from "./aigc-protocol-adapter";
import type { AigcTaskRepository } from "./aigc-task-repository";
import type { AigcWorkflowService } from "./aigc-workflow-service";

interface AigcTaskServiceDependencies {
  repository: AigcTaskRepository;
  interfaces: AigcInterfaceService;
  workflows: AigcWorkflowService;
  connections: AigcConnectionService;
  credentials: CredentialService;
  assets: AigcAssetService;
  adapters: Record<string, AigcProtocolAdapter>;
}

/** 协调 AIGC 手动试运行、状态流转和任务历史。 */
export class AigcTaskService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly executionStates = new Map<string, AigcTaskExecutionState>();

  /**
   * @param dependencies AIGC 任务执行依赖
   */
  constructor(private readonly dependencies: AigcTaskServiceDependencies) {}

  /** 列出任务摘要。 */
  async list(): Promise<AigcTaskDocument> {
    return {
      tasks: (await this.dependencies.repository.list()).map((task) => toSummary(task, this.executionStates.get(task.id))),
    };
  }

  /** 读取任务详情。 */
  async get(id: string): Promise<AigcTaskRecord | undefined> {
    const task = await this.dependencies.repository.get(id);
    return task ? withExecutionState(task, this.executionStates.get(id)) : undefined;
  }

  /** 创建任务并异步开始执行。 */
  async createRun(request: AigcRunRequest): Promise<AigcTaskRecord> {
    const item = await this.dependencies.interfaces.get(request.interfaceId);
    if (!item) throw new Error("AIGC 接口不存在");
    if (!item.enabled) throw new Error("AIGC 接口未启用");
    const now = new Date().toISOString();
    const task = await this.dependencies.repository.create({
      id: randomUUID(),
      interfaceId: item.id,
      interfaceName: item.name,
      channelId: item.channelId,
      status: "queued",
      inputs: { ...request.inputs },
      assets: [],
      createdAt: now,
      updatedAt: now,
    });
    void this.executeTask(task.id).catch(() => undefined);
    return task;
  }

  /** 取消排队中或执行中的任务。 */
  async cancel(id: string): Promise<AigcTaskRecord | undefined> {
    const task = await this.dependencies.repository.get(id);
    if (!task) throw new Error("AIGC 任务不存在");
    if (task.status !== "queued" && task.status !== "running") throw new Error("仅排队中或执行中的任务可以取消");
    this.controllers.get(id)?.abort();
    this.executionStates.delete(id);
    return this.updateTask(id, { status: "cancelled", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  }

  /** 重新执行失败或已取消的任务。 */
  async retry(id: string): Promise<AigcTaskRecord | undefined> {
    const task = await this.dependencies.repository.get(id);
    if (!task) throw new Error("AIGC 任务不存在");
    if (task.status !== "failed" && task.status !== "cancelled") throw new Error("仅失败或已取消的任务可以重试");
    this.executionStates.delete(id);
    const next = await this.updateTask(id, {
      status: "queued",
      assets: [],
      error: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      updatedAt: new Date().toISOString(),
    });
    if (next) void this.executeTask(next.id).catch(() => undefined);
    return next;
  }

  /** 执行任务并写入最终状态。 */
  private async executeTask(id: string): Promise<void> {
    const task = await this.dependencies.repository.get(id);
    if (!task || task.status !== "queued") return;
    const item = await this.dependencies.interfaces.get(task.interfaceId);
    if (!item) return this.failTask(id, { code: "AIGC_INTERFACE_MISSING", message: "AIGC 接口不存在" });
    const channel = (await this.dependencies.connections.read()).channels.find((candidate) => candidate.id === item.channelId);
    if (!channel) return this.failTask(id, { code: "AIGC_CHANNEL_MISSING", message: "AIGC 渠道不存在" });
    if (!channel.enabled) return this.failTask(id, { code: "AIGC_CHANNEL_DISABLED", message: "AIGC 渠道未启用" });
    const adapter = this.dependencies.adapters[item.protocol];
    if (!adapter) return this.failTask(id, { code: "AIGC_PROTOCOL_UNSUPPORTED", message: "AIGC 协议暂不支持" });
    const controller = new AbortController();
    this.controllers.set(id, controller);
    await this.updateTask(id, { status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    try {
      const apiKey = await this.dependencies.credentials.getApiKey(channel.id);
      const result = await adapter.execute({
        item,
        channel,
        apiKey,
        inputs: task.inputs,
        assets: this.dependencies.assets,
        workflows: this.dependencies.workflows,
        signal: controller.signal,
        onProgress: (state) => {
          // 进度事件可能非常密集，只保留内存快照供轮询接口读取。
          if (!controller.signal.aborted && this.controllers.get(id) === controller) {
            this.executionStates.set(id, { ...state });
          }
        },
      });
      const assets = [];
      for (const output of result.assets) {
        assets.push(await this.dependencies.assets.saveOutput(id, output.content, output.name, output.mediaType));
      }
      await this.updateTask(id, {
        status: "succeeded",
        assets,
        error: undefined,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        await this.updateTask(id, { status: "cancelled", finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      } else {
        await this.failTask(id, sanitizeError(error));
      }
    } finally {
      this.executionStates.delete(id);
      this.controllers.delete(id);
    }
  }

  /** 写入失败状态。 */
  private async failTask(id: string, error: AigcTaskError): Promise<void> {
    await this.updateTask(id, {
      status: "failed",
      error,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** 更新任务并返回最新记录。 */
  private async updateTask(id: string, patch: Partial<AigcTaskRecord>): Promise<AigcTaskRecord | undefined> {
    const updated = await this.dependencies.repository.update(id, patch);
    return updated;
  }
}

/** 将任务记录映射为列表摘要。 */
function toSummary(task: AigcTaskRecord, execution?: AigcTaskExecutionState): AigcTaskSummary {
  return {
    id: task.id,
    interfaceId: task.interfaceId,
    interfaceName: task.interfaceName,
    channelId: task.channelId,
    status: task.status,
    assetCount: task.assets.length,
    ...(execution ? { execution: { ...execution } } : {}),
    ...(task.error ? { error: task.error } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
  };
}

/** 给任务详情附加不落盘的实时执行状态。 */
function withExecutionState(task: AigcTaskRecord, execution?: AigcTaskExecutionState): AigcTaskRecord {
  return execution ? { ...task, execution: { ...execution } } : task;
}

/** 将异常转换为不包含认证信息的任务错误。 */
function sanitizeError(error: unknown): AigcTaskError {
  const message = error instanceof Error ? error.message : "AIGC 任务执行失败";
  return {
    code: error instanceof TypeError ? "AIGC_INPUT_INVALID" : "AIGC_UPSTREAM_FAILED",
    message: message.includes("Bearer") || message.includes("apiKey") ? "AIGC 上游服务不可用" : message,
  };
}
