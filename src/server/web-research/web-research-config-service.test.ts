import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { VersionConflictError } from "../configuration/versioned-json-store";
import { WebResearchConfigService } from "./web-research-config-service";

describe("联网搜索配置服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "web-research-config-"));
    roots.push(root);
    return new WebResearchConfigService(join(root, "web-research.json"));
  }

  it("缺失配置时返回保守默认值", async () => {
    const service = await fixture();

    await expect(service.read()).resolves.toMatchObject({
      config: {
        enabled: false,
        searxngBaseUrl: "http://bug-paw-search:8080",
        egressProfileId: "direct",
        httpsOnly: true,
        maxResults: 5,
        maxTextLength: 20_000,
        timeoutMs: 10_000,
        maxRedirects: 3,
        maxResponseBytes: 2 * 1024 * 1024,
        allowedDomains: [],
        allowedContentTypes: ["text/html", "text/plain"],
      },
    });
  });

  it("拒绝旧 revision 写入", async () => {
    const service = await fixture();
    const current = await service.read();

    await service.update({ ...current.config, enabled: true }, current.revision);

    await expect(service.update(current.config, current.revision)).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("仅迁移已保存的旧内部 SearXNG 地址", async () => {
    const service = await fixture();
    const initial = await service.read();
    const legacy = await service.update({ ...initial.config, searxngBaseUrl: "http://searxng:8080" }, initial.revision);

    await service.migrateLegacyInternalHost();

    await expect(service.read()).resolves.toMatchObject({
      config: { searxngBaseUrl: "http://bug-paw-search:8080" },
    });
    const external = await service.update({ ...legacy.config, searxngBaseUrl: "https://search.example" }, (await service.read()).revision);
    await service.migrateLegacyInternalHost();
    await expect(service.read()).resolves.toMatchObject({
      revision: external.revision,
      config: { searxngBaseUrl: "https://search.example" },
    });
  });

  it("拒绝不安全的配置范围", async () => {
    const service = await fixture();
    const current = await service.read();

    await expect(service.update({ ...current.config, maxResults: 21 }, current.revision)).rejects.toThrow("搜索结果数必须在 1 到 20 之间");
  });
});
