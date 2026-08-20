import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigTransaction } from "../configuration/config-transaction";
import { CredentialService } from "../configuration/credential-service";
import { AigcConnectionManagementService } from "./aigc-connection-management-service";
import { AigcConnectionService } from "./aigc-connection-service";

describe("AIGC 渠道管理", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "aigc-connections-"));
    roots.push(root);
    const configPath = join(root, "aigc-connections.json");
    const authPath = join(root, "aigc-auth.json");
    const connections = new AigcConnectionService(configPath);
    const credentials = new CredentialService(authPath);
    const management = new AigcConnectionManagementService({
      connections,
      credentials,
      configPath,
      authPath,
      transaction: new ConfigTransaction({ rootDir: root, transactionDir: join(root, "transactions") }),
    });
    return { management, connections, credentials };
  }

  it("ComfyUI 渠道可不配置 API Key，OpenAI 渠道必须配置", async () => {
    const { management } = await fixture();
    let document = await management.document();
    const comfy = {
      id: "comfy-local",
      name: "本地 ComfyUI",
      type: "comfyui" as const,
      baseUrl: "http://127.0.0.1:8188",
      enabled: true,
    };
    await management.add({
      configRevision: document.revision,
      credentialRevision: document.credentialRevision,
      channel: comfy,
    });

    document = await management.document();
    expect(document.channels).toEqual([expect.objectContaining({ id: "comfy-local", hasApiKey: false })]);
    expect(document.channels[0].timeoutMs).toBeUndefined();

    await expect(management.add({
      configRevision: document.revision,
      credentialRevision: document.credentialRevision,
      channel: {
        id: "openai-official",
        name: "OpenAI",
        type: "openai",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        timeoutMs: 30_000,
      },
    })).rejects.toThrow("必须配置 API Key");
  });

  it("创建 OpenAI 渠道后只返回脱敏状态，并支持保留或删除凭证", async () => {
    const { management } = await fixture();
    let document = await management.document();
    await management.add({
      configRevision: document.revision,
      credentialRevision: document.credentialRevision,
      channel: {
        id: "openai-official",
        name: "OpenAI",
        type: "openai",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        timeoutMs: 30_000,
      },
      apiKey: "sk-secret",
    });

    document = await management.document();
    expect(JSON.stringify(document)).not.toContain("sk-secret");
    expect(document.channels[0]).toMatchObject({ hasApiKey: true });

    await management.update("openai-official", {
      configRevision: document.revision,
      credentialRevision: document.credentialRevision,
      channel: {
        id: "openai-official",
        name: "OpenAI 重命名",
        type: "openai",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        timeoutMs: 30_000,
      },
      credential: { action: "keep" },
    });
    document = await management.document();
    expect(document.channels[0]).toMatchObject({ name: "OpenAI 重命名", hasApiKey: true });

    await expect(management.update("openai-official", {
      configRevision: document.revision,
      credentialRevision: document.credentialRevision,
      channel: {
        id: "openai-official",
        name: "OpenAI 重命名",
        type: "openai",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        timeoutMs: 30_000,
      },
      credential: { action: "remove" },
    })).rejects.toThrow("必须配置 API Key");
  });

  it("拒绝包含内嵌凭证的服务地址", async () => {
    const { connections } = await fixture();
    await expect(connections.validate({
      name: "无效渠道",
      type: "comfyui",
      baseUrl: "https://user:pass@example.com",
      enabled: true,
      timeoutMs: 30_000,
    }, "invalid")).rejects.toThrow("地址必须不含凭证");
  });
});
