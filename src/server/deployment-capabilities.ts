/** 容器部署时可由组合配置声明的托管能力。 */
export interface DeploymentCapabilities {
  /** 是否随部署提供内部 SearXNG 服务。 */
  managedSearchAvailable: boolean;
  /** 是否随部署提供内部 Embedding 服务。 */
  managedEmbeddingAvailable: boolean;
  /** 是否随部署提供 Playwright Worker 与受控出口。 */
  browserAutomationAvailable: boolean;
}

/** 从环境变量读取部署能力，仅接受明确的小写 true。 */
export function readDeploymentCapabilities(
  env: Readonly<Record<string, string | undefined>>,
): DeploymentCapabilities {
  return {
    managedSearchAvailable: env.BUG_PAW_MANAGED_SEARCH_AVAILABLE === "true",
    managedEmbeddingAvailable: env.BUG_PAW_MANAGED_EMBEDDING_AVAILABLE === "true",
    browserAutomationAvailable: env.BUG_PAW_BROWSER_AUTOMATION_AVAILABLE === "true",
  };
}
