import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BrowserAutomationConfig, TrustedBrowserOrigin } from "../../shared/browser-automation-contracts";
import { VersionConflictError } from "../configuration/versioned-json-store";
import { BrowserConfigService } from "./browser-config-service";

/** 浏览器能力配置的默认值、边界与乐观锁行为。 */
describe("浏览器能力配置服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "browser-automation-config-"));
    roots.push(root);
    return new BrowserConfigService(join(root, "browser-automation.json"));
  }

  it("缺失配置时返回适合慢模型的保守默认值", async () => {
    const service = await fixture();

    await expect(service.read()).resolves.toMatchObject({
      config: {
        enabled: false,
        publicBrowsing: {
          httpsOnly: true,
          allowedDomains: [],
          navigationTimeoutMs: 60_000,
          maxPagesPerContext: 2,
          maxPagesPerRun: 50,
        },
        trustedOrigins: [],
        localPreview: {
          allowTextInput: false,
          allowFormSubmit: false,
          allowFileUpload: false,
          grantedPermissions: [],
        },
        pool: {
          maxContexts: 1,
          maxContextsPerAgent: 1,
          queueCapacity: 10,
          queueWaitMs: 30 * 60_000,
          heartbeatIntervalMs: 30_000,
          orphanTimeoutMs: 15 * 60_000,
          runTimeoutMs: 90 * 60_000,
        },
        artifacts: {
          maxScreenshotsPerRun: 20,
          maxDownloadsPerRun: 10,
          maxDownloadBytes: 50 * 1024 * 1024,
          maxDownloadBytesPerRun: 200 * 1024 * 1024,
          downloadTimeoutMs: 3 * 60_000,
          screenshotFormats: ["png", "jpeg"],
        },
        auditRetentionDays: 30,
      },
    });
  });

  it.each([
    "https://*.example.com",
    "https://example.com/path",
    "https://user@example.com",
  ])("拒绝不精确或含凭证的受信任 Origin：%s", async (origin) => {
    const service = await fixture();
    const current = await service.read();

    await expect(service.update({
      ...current.config,
      trustedOrigins: [trustedOrigin(origin)],
    }, current.revision)).rejects.toThrow("受信任 Origin 必须精确到 Scheme、Host 和 Port");
  });

  it("拒绝把云元数据地址加入受信任 Origin", async () => {
    const service = await fixture();
    const current = await service.read();

    await expect(service.update({
      ...current.config,
      trustedOrigins: [trustedOrigin("http://169.254.169.254")],
    }, current.revision)).rejects.toThrow("云元数据地址不能配置为受信任 Origin");
  });

  it("拒绝重复 Origin 和不在安全清单内的浏览器权限", async () => {
    const service = await fixture();
    const current = await service.read();
    const origin = trustedOrigin("https://staging.example.com");

    await expect(service.update({ ...current.config, trustedOrigins: [origin, origin] }, current.revision))
      .rejects.toThrow("受信任 Origin 不能重复");
    await expect(service.update({
      ...current.config,
      trustedOrigins: [{ ...origin, grantedPermissions: ["camera"] } as unknown as TrustedBrowserOrigin],
    }, current.revision)).rejects.toThrow("浏览器权限不在允许清单中");
  });

  it.each([
    ["全局浏览器上下文数", (config: BrowserAutomationConfig) => ({ ...config, pool: { ...config.pool, maxContexts: 5 } })],
    ["队列等待时间", (config: BrowserAutomationConfig) => ({ ...config, pool: { ...config.pool, queueWaitMs: 61 * 60_000 } })],
    ["单次下载大小", (config: BrowserAutomationConfig) => ({ ...config, artifacts: { ...config.artifacts, maxDownloadBytes: 0 } })],
  ])("拒绝越界的%s", async (_label, mutate) => {
    const service = await fixture();
    const current = await service.read();

    await expect(service.update(mutate(current.config), current.revision)).rejects.toThrow("必须在");
  });

  it("规范化 Origin、域名和 MIME，并拒绝旧 revision", async () => {
    const service = await fixture();
    const current = await service.read();
    const updated = await service.update({
      ...current.config,
      publicBrowsing: { ...current.config.publicBrowsing, allowedDomains: ["Example.COM", "example.com"] },
      trustedOrigins: [trustedOrigin("https://STAGING.example.com:443")],
      artifacts: {
        ...current.config.artifacts,
        allowedDownloadMimeTypes: ["APPLICATION/PDF", "application/pdf"],
      },
    }, current.revision);

    expect(updated.config.publicBrowsing.allowedDomains).toEqual(["example.com"]);
    expect(updated.config.trustedOrigins[0]?.origin).toBe("https://staging.example.com");
    expect(updated.config.artifacts.allowedDownloadMimeTypes).toEqual(["application/pdf"]);
    await expect(service.update(current.config, current.revision)).rejects.toBeInstanceOf(VersionConflictError);
  });
});

/** 创建全部高风险开关关闭的测试 Origin。 */
function trustedOrigin(origin: string): TrustedBrowserOrigin {
  return {
    origin,
    allowTextInput: false,
    allowFormSubmit: false,
    allowFileUpload: false,
    grantedPermissions: [],
  };
}
