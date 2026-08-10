// @vitest-environment node

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CredentialService } from "./credential-service";

describe("CredentialService", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("写入 Pi 原生 API Key 结构但公开列表只返回脱敏状态", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-credential-service-"));
    roots.push(root);
    const authPath = join(root, "auth.json");
    const credentials = new CredentialService(authPath);

    await credentials.setApiKey("example", "test-secret");

    expect(await credentials.list()).toEqual([{ providerId: "example", type: "api_key", configured: true }]);
    expect(JSON.stringify(await credentials.list())).not.toContain("test-secret");
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      example: { type: "api_key", key: "test-secret" },
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  it("仅向服务端调用方返回目标 api_key 凭证", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-credential-service-"));
    roots.push(root);
    const authPath = join(root, "auth.json");
    const credentials = new CredentialService(authPath);
    await credentials.setApiKey("openai", "test-key");
    await writeFile(
      authPath,
      '{"openai":{"type":"api_key","key":"test-key"},"oauth-provider":{"type":"oauth","access":"oauth-secret"}}\n',
      { encoding: "utf8", mode: 0o600 },
    );

    await expect(credentials.getApiKey("openai")).resolves.toBe("test-key");
    await expect(credentials.getApiKey("missing")).resolves.toBeUndefined();
    await expect(credentials.getApiKey("oauth-provider")).resolves.toBeUndefined();
    expect(await credentials.list()).toEqual([
      { providerId: "openai", type: "api_key", configured: true },
      { providerId: "oauth-provider", type: "oauth", configured: true },
    ]);
  });

  it("删除目标 Provider 时保留其他类型凭证且列表不泄露 OAuth 或 env", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-credential-service-"));
    roots.push(root);
    const authPath = join(root, "auth.json");
    await writeFile(
      authPath,
      '{"example":{"type":"api_key","key":"test-secret"},"oauth-provider":{"type":"oauth","access":"oauth-secret","env":{"TOKEN":"env-secret"}}}\n',
      { encoding: "utf8", mode: 0o600 },
    );
    const credentials = new CredentialService(authPath);
    const revision = await credentials.getRevision();

    await credentials.remove("example", revision);

    const serializedList = JSON.stringify(await credentials.list());
    expect(serializedList).not.toMatch(/test-secret|oauth-secret|env-secret/);
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      "oauth-provider": { type: "oauth", access: "oauth-secret", env: { TOKEN: "env-secret" } },
    });
  });
});
