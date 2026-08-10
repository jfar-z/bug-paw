import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TtsConfigService } from "./tts-config-service";

describe("语音合成配置服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<TtsConfigService> {
    const root = await mkdtemp(join(tmpdir(), "tts-config-"));
    roots.push(root);
    return new TtsConfigService(join(root, "tts.json"));
  }

  it("创建后只返回脱敏配置摘要", async () => {
    const service = await fixture();

    const created = await service.create({
      name: "中文语音",
      baseUrl: "https://tts.example/v1",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "mp3",
      apiKey: randomUUID(),
    });

    expect(created.profile).toMatchObject({
      name: "中文语音",
      baseUrl: "https://tts.example/v1",
      hasApiKey: true,
    });
    expect(created.profile).not.toHaveProperty("apiKey");
  });

  it("更新时以空值保留既有密钥并拒绝含凭证的地址", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "中文语音",
      baseUrl: "https://tts.example/v1",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "mp3",
      apiKey: randomUUID(),
    });

    const updated = await service.update(created.profile.id, {
      name: "更新后的中文语音",
      baseUrl: "https://tts.example/v1/",
      model: "tts-1-hd",
      voice: "nova",
      responseFormat: "opus",
      apiKey: "",
    }, created.revision);

    expect(updated.profile).toMatchObject({
      name: "更新后的中文语音",
      baseUrl: "https://tts.example/v1",
      model: "tts-1-hd",
      voice: "nova",
      responseFormat: "opus",
      hasApiKey: true,
    });
    await expect(service.create({
      name: "无效配置",
      baseUrl: "https://user@example/v1",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "mp3",
      apiKey: randomUUID(),
    })).rejects.toThrow("地址必须不含凭证");
  });
});
