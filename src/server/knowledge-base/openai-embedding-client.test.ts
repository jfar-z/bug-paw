import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmbeddingConfigService } from "./embedding-config-service";
import { OpenAiEmbeddingClient } from "./openai-embedding-client";

describe("OpenAI 兼容 Embedding 客户端", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("按索引顺序返回有限维度一致的向量", async () => {
    const root = await mkdtemp(join(tmpdir(), "embedding-client-"));
    roots.push(root);
    const configs = new EmbeddingConfigService(join(root, "embedding.json"));
    const initial = await configs.read();
    await configs.update({
      baseUrl: "https://embed.example/v1",
      model: "text-embedding-3-small",
      batchSize: 8,
      apiKey: randomUUID(),
      enabled: true,
    }, initial.revision);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0.3, 0.4] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
    }), { status: 200 }));
    const client = new OpenAiEmbeddingClient(configs, fetchMock);

    await expect(client.embedDocuments(["第一段", "第二段"])).resolves.toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(fetchMock).toHaveBeenCalledWith("https://embed.example/v1/embeddings", expect.objectContaining({ method: "POST" }));
  });

  it("拒绝缺项和维度不一致的上游响应", async () => {
    const root = await mkdtemp(join(tmpdir(), "embedding-client-"));
    roots.push(root);
    const configs = new EmbeddingConfigService(join(root, "embedding.json"));
    const initial = await configs.read();
    await configs.update({
      baseUrl: "https://embed.example/v1",
      model: "text-embedding-3-small",
      batchSize: 8,
      apiKey: randomUUID(),
      enabled: true,
    }, initial.revision);
    const client = new OpenAiEmbeddingClient(configs, async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1] }, { index: 1, embedding: [0.2, 0.3] }],
    }), { status: 200 }));

    await expect(client.embedDocuments(["第一段", "第二段"])).rejects.toThrow("Embedding 响应无效");
  });

  it("受管模型保持文档原文并只为查询添加检索前缀", async () => {
    const root = await mkdtemp(join(tmpdir(), "embedding-client-"));
    roots.push(root);
    const requests: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
      }), { status: 200 });
    });
    const client = new OpenAiEmbeddingClient(new EmbeddingConfigService(join(root, "embedding.json")), fetchMock as typeof fetch);

    await client.embedDocuments(["资料正文"]);
    await client.embedQuery("报销流程");

    const [documentRequest, queryRequest] = requests;
    expect(JSON.parse(String(documentRequest.body))).toMatchObject({ input: ["资料正文"] });
    expect(JSON.parse(String(queryRequest.body))).toMatchObject({ input: ["为这个句子生成表示以用于检索相关文章：报销流程"] });
    expect(documentRequest.headers).toEqual({ "Content-Type": "application/json" });
  });
});
