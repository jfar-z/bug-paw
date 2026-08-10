import type { DataPaths } from "../paths";
import { AgentStore, type AgentStoreDependencies } from "./agent-store";
import type { AgentRepository } from "./agent-repository";

/** Agent 应用服务依赖，集中描述跨数据库与文件系统的协调能力。 */
export type AgentServiceDependencies = AgentStoreDependencies;

/**
 * 创建 Agent 应用服务。
 *
 * AgentStore 现已只承担应用服务职责；该工厂防止装配层绕过 Repository 自行拼装状态。
 */
export function createAgentService(
  paths: DataPaths,
  dependencies: AgentServiceDependencies,
  repository: AgentRepository,
): AgentStore {
  return new AgentStore(paths, dependencies, repository);
}

export type AgentService = AgentStore;
