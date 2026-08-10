import type { FastifyInstance } from "fastify";

import type { EmbeddingConfigInput } from "../../shared/knowledge-retrieval-contracts";
import type { EmbeddingConfigService } from "../knowledge-base/embedding-config-service";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

/** 语义索引重建后的公开统计。 */
export interface KnowledgeRebuildResult {
  totalBases: number;
  rebuiltBases: number;
  failedBases: string[];
}

interface KnowledgeRetrievalRouteDependencies {
  authService: AuthService;
  configs: EmbeddingConfigService;
  rebuildAll(): Promise<KnowledgeRebuildResult>;
}

/** 注册 Embedding 与语义检索的配置、重建接口。 */
export function registerKnowledgeRetrievalRoutes(app: FastifyInstance, dependencies: KnowledgeRetrievalRouteDependencies): void {
  app.get("/api/capabilities/knowledge-retrieval", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    return reply.send(await dependencies.configs.read());
  });

  app.patch("/api/capabilities/knowledge-retrieval", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    const config = body ? readInput(body.config) : undefined;
    if (!body || typeof body.revision !== "string" || !config) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "Embedding 配置格式无效");
    }
    try {
      reply.header("Cache-Control", "no-store");
      return reply.send(await dependencies.configs.update(config, body.revision));
    } catch (error) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", error instanceof Error ? error.message : "Embedding 配置无效");
    }
  });

  app.post("/api/capabilities/knowledge-retrieval/rebuild", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const config = await dependencies.configs.getPrivate();
    if (!config) {
      return sendApiError(reply, 409, "MODEL_IN_USE", "请先配置 Embedding 模型");
    }
    if (!config.enabled) {
      return sendApiError(reply, 409, "MODEL_IN_USE", "请先启用语义检索");
    }
    try {
      reply.header("Cache-Control", "no-store");
      return reply.send(await dependencies.rebuildAll());
    } catch {
      return sendApiError(reply, 502, "VALIDATION_FAILED", "语义索引重建失败");
    }
  });
}

/** 解析浏览器提交的单一配置。 */
function readInput(value: unknown): EmbeddingConfigInput | undefined {
  if (!isRecord(value)
    || typeof value.baseUrl !== "string"
    || typeof value.model !== "string"
    || typeof value.batchSize !== "number"
    || typeof value.apiKey !== "string") return undefined;
  return { baseUrl: value.baseUrl, model: value.model, batchSize: value.batchSize, apiKey: value.apiKey, enabled: value.enabled !== false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
