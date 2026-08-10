import { EmbeddingConfigService } from "./embedding-config-service";

const BGE_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";

/** 通过服务端保存的配置调用 OpenAI 兼容 Embedding 接口。 */
export class OpenAiEmbeddingClient {
  /**
   * @param configs Embedding 配置读取服务
   * @param request 可注入的请求函数，便于隔离外部服务测试
   */
  constructor(
    private readonly configs: EmbeddingConfigService,
    private readonly request: typeof fetch = fetch,
  ) {}

  /** 将资料切片转换为与输入顺序一致的向量。 */
  async embedDocuments(input: string[], signal?: AbortSignal): Promise<number[][]> {
    if (input.length === 0 || input.some((text) => !text.trim())) throw new TypeError("Embedding 文本不能为空");
    const config = await this.configs.getPrivate();
    if (!config) throw new Error("尚未配置 Embedding 服务");
    const vectors: number[][] = [];
    for (let offset = 0; offset < input.length; offset += config.batchSize) {
      vectors.push(...await this.embedBatch(config, input.slice(offset, offset + config.batchSize), signal));
    }
    return vectors;
  }

  /** 为知识库查询添加 BGE 检索前缀后生成单一向量。 */
  async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
    const normalized = query.trim();
    if (!normalized) throw new TypeError("Embedding 文本不能为空");
    const [vector] = await this.embedDocuments([`${BGE_QUERY_PREFIX}${normalized}`], signal);
    return vector;
  }

  /** 发送单个符合已配置批量限制的 OpenAI 兼容请求。 */
  private async embedBatch(config: { baseUrl: string; model: string; apiKey: string }, input: string[], signal?: AbortSignal): Promise<number[][]> {
    let response: Response;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      response = await this.request(`${config.baseUrl}/embeddings`, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify({ model: config.model, input }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Embedding 服务暂时不可用");
    }
    if (response.status === 429 && input.length > 1) {
      const splitAt = Math.ceil(input.length / 2);
      const left = await this.embedBatch(config, input.slice(0, splitAt), signal);
      const right = await this.embedBatch(config, input.slice(splitAt), signal);
      return [...left, ...right];
    }
    if (!response.ok) throw new Error("Embedding 服务暂时不可用");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Embedding 响应无效");
    }
    return readEmbeddings(payload, input.length);
  }
}

/** 校验 OpenAI 响应并按 index 还原输入顺序。 */
function readEmbeddings(payload: unknown, expectedLength: number): number[][] {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length !== expectedLength) {
    throw new Error("Embedding 响应无效");
  }
  const vectors: Array<number[] | undefined> = Array.from({ length: expectedLength });
  let dimensions: number | undefined;
  for (const entry of payload.data) {
    if (!isRecord(entry) || !Number.isInteger(entry.index) || !Array.isArray(entry.embedding)) {
      throw new Error("Embedding 响应无效");
    }
    const index = entry.index as number;
    if (index < 0 || index >= expectedLength) throw new Error("Embedding 响应无效");
    const vector = entry.embedding;
    if (vector.length === 0 || vector.some((value) => typeof value !== "number" || !Number.isFinite(value)) || vectors[index] !== undefined) {
      throw new Error("Embedding 响应无效");
    }
    if (dimensions !== undefined && dimensions !== vector.length) throw new Error("Embedding 响应无效");
    dimensions = vector.length;
    vectors[index] = vector as number[];
  }
  if (vectors.some((vector) => vector === undefined)) throw new Error("Embedding 响应无效");
  return vectors as number[][];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
