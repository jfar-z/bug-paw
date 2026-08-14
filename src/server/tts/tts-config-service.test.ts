import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("保存并返回模型级自定义请求参数", async () => {
    const service = await fixture();

    const created = await service.create({
      name: "情绪语音",
      baseUrl: "https://tts.example/v1",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "mp3",
      apiKey: randomUUID(),
      customParameters: { response_format: "pcm", instructions: "用愉快语气朗读" },
    });

    expect(created.profile.customParameters).toEqual({
      response_format: "pcm",
      instructions: "用愉快语气朗读",
    });
    await expect(service.getPrivate(created.profile.id)).resolves.toMatchObject({
      customParameters: { response_format: "pcm", instructions: "用愉快语气朗读" },
    });
  });

  it("兼容缺少自定义参数的旧配置并忽略旧记录中的非法参数", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-config-legacy-"));
    roots.push(root);
    const filePath = join(root, "tts.json");
    await writeFile(filePath, JSON.stringify({
      profiles: [
        {
          id: "legacy-valid",
          name: "旧语音",
          baseUrl: "https://tts.example/v1",
          model: "tts-1",
          voice: "alloy",
          responseFormat: "mp3",
          apiKey: "legacy-key",
        },
        {
          id: "legacy-invalid",
          name: "旧错误参数",
          baseUrl: "https://tts.example/v1",
          model: "tts-1",
          voice: "alloy",
          responseFormat: "mp3",
          apiKey: "legacy-key",
          customParameters: { input: "错误覆盖" },
        },
      ],
    }), "utf8");

    const listed = await new TtsConfigService(filePath).list();

    expect(listed.profiles).toHaveLength(2);
    expect(listed.profiles.map((profile) => profile.customParameters)).toEqual([{}, {}]);
  });

  it("拒绝受保护字段和超过上限的模型参数", async () => {
    const service = await fixture();
    const base = {
      name: "无效参数",
      baseUrl: "https://tts.example/v1",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "mp3" as const,
      apiKey: randomUUID(),
    };

    await expect(service.create({ ...base, customParameters: { input: "覆盖" } }))
      .rejects.toThrow("不能覆盖 input");
    await expect(service.create({ ...base, customParameters: { instructions: "好".repeat(6_000) } }))
      .rejects.toThrow("不能超过 16 KiB");
  });
});
