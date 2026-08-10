// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { ComposerCatalogService } from "./composer-catalog";

describe("ComposerCatalogService", () => {
  it("TTL 内的并发请求只执行一次资源和工作区扫描", async () => {
    const listReferences = vi.fn(async () => [{ path: "README.md", name: "README.md", kind: "file" as const }]);
    const loadResourceCatalog = vi.fn(async () => ({
      resources: [{
        id: "skill:/skills/review/SKILL.md",
        type: "skill" as const,
        enabled: true,
        name: "review",
        description: "审阅",
        path: "/skills/review/SKILL.md",
        source: "local",
        scope: "agent" as const,
        origin: "top-level" as const,
        inherited: false,
      }],
      tools: [], diagnostics: [], packages: [],
    }));
    const service = new ComposerCatalogService({
      agents: { get: vi.fn(async () => ({ profile: { cwd: "/workspace/a1" } })) } as never,
      agentDir: "/data/pi",
      knowledgeBases: { listBasesForAgent: vi.fn(async () => []) } as never,
      workspaceFiles: { listReferences } as never,
      listCommandsForAgent: vi.fn(async () => []),
      loadResourceCatalog,
    });

    const [left, right] = await Promise.all([service.list("a1"), service.list("a1")]);
    const third = await service.list("a1");

    expect(left).toEqual(right);
    expect(third).toEqual(left);
    expect(listReferences).toHaveBeenCalledOnce();
    expect(loadResourceCatalog).toHaveBeenCalledOnce();
  });
});
