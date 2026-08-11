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

  it("使用独立 revision 新增实例且不修改凭证文件", async () => {
    const fixture = await createFixture();
    const current = await fixture.configs.read();
    const credentialRevision = await fixture.credentials.getRevision();

    const result = await fixture.service.add({
      id: "bocha-main",
      name: "博查主线路",
      type: "bocha",
      connectionMode: "official",
      enabled: false,
      timeoutMs: 8_000,
    }, current.revision);

    expect(result.config.searchProviders.at(-1)).toMatchObject({ id: "bocha-main" });
    expect(await fixture.credentials.getRevision()).toBe(credentialRevision);
  });

  it("旧 revision 删除失败时配置和凭证都保持原值", async () => {
    const fixture = await createFixture();
    const current = await fixture.configs.read();
    const added = await fixture.service.add({
      id: "tavily-backup",
      name: "Tavily 备用",
      type: "tavily",
      connectionMode: "official",
      enabled: false,
      timeoutMs: 10_000,
    }, current.revision);
    const credentialRevision = await fixture.credentials.setApiKey("tavily-backup", "keep-secret", await fixture.credentials.getRevision());

    await expect(fixture.service.remove("tavily-backup", current.revision, credentialRevision)).rejects.toBeInstanceOf(VersionConflictError);
    expect((await fixture.configs.read()).config.searchProviders).toContainEqual(expect.objectContaining({ id: "tavily-backup" }));
    expect(await fixture.credentials.getApiKey("tavily-backup")).toBe("keep-secret");
    expect(added.revision).not.toBe(current.revision);
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
});
