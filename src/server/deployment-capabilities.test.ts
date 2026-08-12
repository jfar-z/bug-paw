import { describe, expect, it } from "vitest";

import { readDeploymentCapabilities } from "./deployment-capabilities";

describe("部署能力配置", () => {
  it("默认不声明任何托管扩展能力", () => {
    expect(readDeploymentCapabilities({})).toEqual({
      managedSearchAvailable: false,
      managedEmbeddingAvailable: false,
      browserAutomationAvailable: false,
    });
  });

  it("仅接受精确的 true 开启托管能力", () => {
    expect(readDeploymentCapabilities({
      BUG_PAW_MANAGED_SEARCH_AVAILABLE: "true",
      BUG_PAW_MANAGED_EMBEDDING_AVAILABLE: "TRUE",
      BUG_PAW_BROWSER_AUTOMATION_AVAILABLE: "true",
    })).toEqual({
      managedSearchAvailable: true,
      managedEmbeddingAvailable: false,
      browserAutomationAvailable: true,
    });
  });
});
