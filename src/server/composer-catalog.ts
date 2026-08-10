import type { ComposerCatalog } from "../shared/contracts";
import type { AgentStore } from "./agents/agent-store";
import type { KnowledgeBaseService } from "./knowledge-base/knowledge-base-service";
import type { PiRuntimeGateway } from "./pi-runtime";
import { ResourceService, type ResourceCatalog } from "./resources/resource-service";
import type { WorkspaceFileManager } from "./workspace-files";
import { SYSTEM_LIMITS } from "./core/limits";

/** 输入框候选目录聚合服务的依赖。 */
export interface ComposerCatalogServiceDependencies {
  agents: AgentStore;
  agentDir: string;
  knowledgeBases: KnowledgeBaseService;
  workspaceFiles: WorkspaceFileManager;
  listCommandsForAgent(agentId: string): ReturnType<PiRuntimeGateway["listCommands"]>;
  loadResourceCatalog?(agentId: string, cwd: string): Promise<ResourceCatalog>;
}

/**
 * 按 Agent 聚合可引用资源和 SDK 公开的安全命令，不持久化临时会话。
 */
export class ComposerCatalogService {
  private readonly cache = new Map<string, { expiresAt: number; value: ComposerCatalog | undefined }>();
  private readonly pending = new Map<string, Promise<ComposerCatalog | undefined>>();

  constructor(private readonly dependencies: ComposerCatalogServiceDependencies) {}

  async list(agentId: string): Promise<ComposerCatalog | undefined> {
    const cached = this.cache.get(agentId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const existing = this.pending.get(agentId);
    if (existing) return existing;
    const load = this.load(agentId).then((value) => {
      this.cache.set(agentId, { expiresAt: Date.now() + SYSTEM_LIMITS.composerCatalogTtlMs, value });
      while (this.cache.size > SYSTEM_LIMITS.composerCatalogEntries) {
        this.cache.delete(this.cache.keys().next().value as string);
      }
      return value;
    }).finally(() => this.pending.delete(agentId));
    this.pending.set(agentId, load);
    return load;
  }

  /** 资源或工作区配置变化后显式失效缓存。 */
  invalidate(agentId?: string): void {
    if (agentId) this.cache.delete(agentId);
    else this.cache.clear();
  }

  private async load(agentId: string): Promise<ComposerCatalog | undefined> {
    const agent = await this.dependencies.agents.get(agentId);
    if (!agent) return undefined;
    const loadResources = this.dependencies.loadResourceCatalog
      ?? ((_currentAgentId: string, cwd: string) => new ResourceService({ agentDir: this.dependencies.agentDir, cwd }).catalog());
    const [resourceCatalog, knowledgeBases, workspaceEntries, commands] = await Promise.all([
      loadResources(agentId, agent.profile.cwd),
      this.dependencies.knowledgeBases.listBasesForAgent(agentId),
      this.dependencies.workspaceFiles.listReferences(agentId),
      this.dependencies.listCommandsForAgent(agentId),
    ]);
    return {
      skills: resourceCatalog.resources
        .filter((resource) => resource.type === "skill" && resource.enabled)
        .map((resource) => ({ name: resource.name, description: resource.description }))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
      commands: [...commands].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
      knowledgeBases: knowledgeBases.map((base) => ({ id: base.id, name: base.name })),
      workspaceEntries,
    };
  }
}
