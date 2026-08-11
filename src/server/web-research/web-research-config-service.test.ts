import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { VersionConflictError } from "../configuration/versioned-json-store";
import { ManagedSearchProviderRegistry } from "./managed-search-provider-registry";
import { WebResearchConfigService } from "./web-research-config-service";

describe("联网搜索配置服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(managed = false) {
    const root = await mkdtemp(join(tmpdir(), "web-research-config-"));
    roots.push(root);
    const filePath = join(root, "web-research.json");
    return {
      filePath,
      service: new WebResearchConfigService(
        filePath,
        undefined,
        new ManagedSearchProviderRegistry(managed),
      ),
    };
  }

  it("缺失配置时返回保守默认值", async () => {
    const { service } = await fixture();

    await expect(service.read()).resolves.toMatchObject({
      config: {
        enabled: false,
        searchProviders: [],
        webRead: { egressProfileId: "direct", timeoutMs: 10_000 },
        httpsOnly: true,
        maxResults: 5,
        maxTextLength: 20_000,
        maxRedirects: 3,
        maxResponseBytes: 2 * 1024 * 1024,
        allowedDomains: [],
        allowedContentTypes: ["text/html", "text/plain"],
      },
    });
  });

  it("受管搜索可用时默认提供无需地址的内置 SearXNG", async () => {
    const { service } = await fixture(true);

    await expect(service.read()).resolves.toMatchObject({
      config: {
        searchProviders: [{
          id: "managed-searxng",
          name: "内置 SearXNG",
          type: "searxng",
          connectionMode: "managed",
          enabled: true,
          timeoutMs: 10_000,
        }],
      },
    });
  });

  it("拒绝旧 revision 写入", async () => {
    const { service } = await fixture(true);
    const current = await service.read();

    await service.update({ ...current.config, enabled: true }, current.revision);

    await expect(service.update(current.config, current.revision)).rejects.toBeInstanceOf(VersionConflictError);
  });

  it.each(["http://bug-paw-search:8080", "http://searxng:8080"])("将旧内部地址 %s 幂等迁移为受管实例", async (searxngBaseUrl) => {
    const { filePath, service } = await fixture(true);
    await writeFile(filePath, JSON.stringify(legacyConfig(searxngBaseUrl)), "utf8");

    await service.migrateLegacyConfig();
    const first = await readFile(filePath, "utf8");
    await service.migrateLegacyConfig();

    expect(await readFile(filePath, "utf8")).toBe(first);
    await expect(service.read()).resolves.toMatchObject({
      config: {
        searchProviders: [{ id: "managed-searxng", connectionMode: "managed" }],
        webRead: { egressProfileId: "direct", timeoutMs: 10_000 },
      },
    });
  });

  it("将旧外部地址迁移为保留原值的自定义实例", async () => {
    const { filePath, service } = await fixture(true);
    await writeFile(filePath, JSON.stringify(legacyConfig("https://search.example")), "utf8");

    await service.migrateLegacyConfig();

    await expect(service.read()).resolves.toMatchObject({
      config: {
        searchProviders: [{
          id: "custom-searxng",
          type: "searxng",
          connectionMode: "custom",
          baseUrl: "https://search.example",
        }],
      },
    });
  });

  it("没有受管部署能力时把旧内部地址保留为自定义实例", async () => {
    const { filePath, service } = await fixture(false);
    await writeFile(filePath, JSON.stringify(legacyConfig("http://bug-paw-search:8080")), "utf8");

    await service.migrateLegacyConfig();

    await expect(service.read()).resolves.toMatchObject({
      config: {
        searchProviders: [{ connectionMode: "custom", baseUrl: "http://bug-paw-search:8080" }],
      },
    });
  });

  it("拒绝不安全的配置范围", async () => {
    const { service } = await fixture(true);
    const current = await service.read();

    await expect(service.update({ ...current.config, maxResults: 21 }, current.revision)).rejects.toThrow("搜索结果数必须在 1 到 20 之间");
  });

  it("拒绝启用没有可用搜索实例的配置", async () => {
    const { service } = await fixture();
    const current = await service.read();

    await expect(service.update({ ...current.config, enabled: true }, current.revision)).rejects.toThrow("启用联网搜索前至少配置一个可用搜索服务");
  });

  it("拒绝重复实例标识和错误的连接模式组合", async () => {
    const { service } = await fixture(true);
    const current = await service.read();
    const managed = current.config.searchProviders[0]!;

    await expect(service.update({ ...current.config, searchProviders: [managed, managed] }, current.revision)).rejects.toThrow("搜索服务标识重复");
    await expect(service.update({
      ...current.config,
      searchProviders: [{ ...managed, type: "bocha", connectionMode: "managed" }],
    }, current.revision)).rejects.toThrow("搜索服务连接模式无效");
  });
});

function legacyConfig(searxngBaseUrl: string) {
  return {
    enabled: true,
    searxngBaseUrl,
    egressProfileId: "direct",
    maxResults: 5,
    maxTextLength: 20_000,
    timeoutMs: 10_000,
    maxRedirects: 3,
    maxResponseBytes: 2 * 1024 * 1024,
    httpsOnly: true,
    allowedDomains: [],
    allowedContentTypes: ["text/html", "text/plain"],
  };
}
