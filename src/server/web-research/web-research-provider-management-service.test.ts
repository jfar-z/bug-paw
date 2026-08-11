import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigTransaction } from "../configuration/config-transaction";
import { CredentialService } from "../configuration/credential-service";
import { VersionConflictError } from "../configuration/versioned-json-store";
import { ManagedSearchProviderRegistry } from "./managed-search-provider-registry";
import { WebResearchConfigService } from "./web-research-config-service";
import { WebResearchProviderManagementService } from "./web-research-provider-management-service";

describe("联网搜索 Provider 管理服务", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("原子新增直连渠道及其凭证", async () => {
    const fixture = await createFixture();
    const current = await fixture.configs.read();
    const credentialRevision = await fixture.credentials.getRevision();

    await fixture.service.add({
      configRevision: current.revision,
      credentialRevision,
      provider: provider({ id: "bocha-main", name: "博查主线路", enabled: true }),
      apiKey: "bocha-secret",
    });

    expect((await fixture.configs.read()).config.searchProviders.at(-1)).toMatchObject({ id: "bocha-main", enabled: true });
    expect(await fixture.credentials.getApiKey("bocha-main")).toBe("bocha-secret");
  });

  it("凭证 revision 过期时不写入新增渠道", async () => {
    const fixture = await createFixture();
    const current = await fixture.configs.read();
    const staleCredentialRevision = await fixture.credentials.getRevision();
    await fixture.credentials.setApiKey("another-provider", "secret", staleCredentialRevision);

    await expect(fixture.service.add({
      configRevision: current.revision,
      credentialRevision: staleCredentialRevision,
      provider: provider({ id: "bocha-main", enabled: true }),
      apiKey: "bocha-secret",
    })).rejects.toBeInstanceOf(VersionConflictError);

    expect((await fixture.configs.read()).config.searchProviders).not.toContainEqual(expect.objectContaining({ id: "bocha-main" }));
    expect(await fixture.credentials.getApiKey("bocha-main")).toBeUndefined();
  });

  it("编辑渠道时可以保留或替换原有凭证", async () => {
    const fixture = await createFixture();
    await addProvider(fixture, provider({ id: "tavily-backup", type: "tavily", name: "Tavily 备用" }), "old-secret");

    let current = await fixture.configs.read();
    let credentialRevision = await fixture.credentials.getRevision();
    await fixture.service.update("tavily-backup", {
      configRevision: current.revision,
      credentialRevision,
      provider: provider({ id: "tavily-backup", type: "tavily", name: "Tavily 主线路" }),
      credential: { action: "keep" },
    });
    expect(await fixture.credentials.getApiKey("tavily-backup")).toBe("old-secret");

    current = await fixture.configs.read();
    credentialRevision = await fixture.credentials.getRevision();
    await fixture.service.update("tavily-backup", {
      configRevision: current.revision,
      credentialRevision,
      provider: provider({ id: "tavily-backup", type: "tavily", name: "Tavily 主线路" }),
      credential: { action: "replace", apiKey: "new-secret" },
    });
    expect(await fixture.credentials.getApiKey("tavily-backup")).toBe("new-secret");
  });

  it("禁止启用缺少凭证的直连渠道", async () => {
    const fixture = await createFixture();
    await addProvider(fixture, provider({ id: "bocha-main", enabled: true }), "keep-secret");
    const current = await fixture.configs.read();
    const credentialRevision = await fixture.credentials.getRevision();

    await expect(fixture.service.update("bocha-main", {
      configRevision: current.revision,
      credentialRevision,
      provider: provider({ id: "bocha-main", enabled: true }),
      credential: { action: "remove" },
    })).rejects.toThrow("凭证");

    expect(await fixture.credentials.getApiKey("bocha-main")).toBe("keep-secret");
    expect((await fixture.configs.read()).revision).toBe(current.revision);
  });

  it("编辑渠道时禁止修改身份字段", async () => {
    const fixture = await createFixture();
    await addProvider(fixture, provider({ id: "bocha-main" }), "keep-secret");
    const current = await fixture.configs.read();
    const credentialRevision = await fixture.credentials.getRevision();

    await expect(fixture.service.update("bocha-main", {
      configRevision: current.revision,
      credentialRevision,
      provider: provider({ id: "bocha-main", type: "tavily" }),
      credential: { action: "keep" },
    })).rejects.toThrow("不可修改");
  });

  it("仅接受包含全部渠道且不重复的排序", async () => {
    const fixture = await createFixture();
    await addProvider(fixture, provider({ id: "bocha-main" }), "bocha-secret");
    await addProvider(fixture, provider({ id: "tavily-backup", type: "tavily" }), "tavily-secret");
    const current = await fixture.configs.read();
    const ids = current.config.searchProviders.map(({ id }) => id);

    const reordered = await fixture.service.reorder({ revision: current.revision, providerIds: [...ids].reverse() });
    expect(reordered.config.searchProviders.map(({ id }) => id)).toEqual([...ids].reverse());

    await expect(fixture.service.reorder({
      revision: reordered.revision,
      providerIds: reordered.config.searchProviders.slice(0, -1).map(({ id }) => id),
    })).rejects.toThrow("完整排列");
  });

  it("旧 revision 删除失败时配置和凭证都保持原值", async () => {
    const fixture = await createFixture();
    const original = await fixture.configs.read();
    await addProvider(fixture, provider({ id: "tavily-backup", type: "tavily" }), "keep-secret");
    const credentialRevision = await fixture.credentials.getRevision();

    await expect(fixture.service.remove("tavily-backup", original.revision, credentialRevision)).rejects.toBeInstanceOf(VersionConflictError);
    expect((await fixture.configs.read()).config.searchProviders).toContainEqual(expect.objectContaining({ id: "tavily-backup" }));
    expect(await fixture.credentials.getApiKey("tavily-backup")).toBe("keep-secret");
  });

  async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), "web-research-provider-management-"));
    roots.push(root);
    const configPath = join(root, "web-research.json");
    const authPath = join(root, "web-research-auth.json");
    const configs = new WebResearchConfigService(configPath, undefined, new ManagedSearchProviderRegistry(true));
    const credentials = new CredentialService(authPath);
    return {
      configs,
      credentials,
      service: new WebResearchProviderManagementService({
        configs,
        credentials,
        configPath,
        authPath,
        transaction: new ConfigTransaction({ rootDir: root, transactionDir: join(root, "transactions") }),
      }),
    };
  }

  function provider(overrides: Partial<ReturnType<typeof baseProvider>> = {}) {
    return { ...baseProvider(), ...overrides };
  }

  function baseProvider() {
    return {
      id: "bocha-main",
      name: "自定义渠道",
      type: "bocha" as const,
      connectionMode: "official" as const,
      enabled: false,
      timeoutMs: 8_000,
    };
  }

  async function addProvider(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    nextProvider: ReturnType<typeof provider>,
    apiKey: string,
  ) {
    const current = await fixture.configs.read();
    await fixture.service.add({
      configRevision: current.revision,
      credentialRevision: await fixture.credentials.getRevision(),
      provider: nextProvider,
      apiKey,
    });
  }
});
