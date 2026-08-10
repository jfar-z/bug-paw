import type { FastifyInstance, FastifyReply } from "fastify";
import type { AgentStore } from "../agents/agent-store";
import type { CredentialService } from "../configuration/credential-service";
import { hydrateRedacted, scrubSecrets } from "../configuration/configuration-operations-service";
import { ModelConfigurationValidationError, ProviderAlreadyExistsError, ProviderNotFoundError, type ModelConfigService } from "../configuration/model-config-service";
import type { ProviderRenameService } from "../configuration/provider-rename-service";
import { VersionConflictError } from "../configuration/versioned-json-store";
import { ProviderModelDiscoveryError, type DiscoverModelsResult } from "../provider-model-discovery";
import { ModelConnectionTestError, type ModelConnectionTestRequest, type ModelConnectionTestResult } from "../runtime-coordinator";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface ProviderRouteDependencies {
  authService: AuthService;
  models: ModelConfigService;
  credentials: CredentialService;
  agents: AgentStore;
  renameService: ProviderRenameService;
  testModels?: (providerId: string, request: ModelConnectionTestRequest) => Promise<ModelConnectionTestResult>;
  discoverModels?: (providerId: string) => Promise<DiscoverModelsResult>;
  runModelMutation?<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * 注册 Provider、模型和只写凭证配置接口。
 */
export function registerProviderRoutes(app: FastifyInstance, dependencies: ProviderRouteDependencies): void {
  app.get("/api/providers", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const [document, credentials, credentialRevision] = await Promise.all([
      dependencies.models.read(), dependencies.credentials.list(), dependencies.credentials.getRevision(),
    ]);
    return reply.send({ ...publicModelDocument(document), credentials, credentialRevision });
  });

  app.get<{ Params: { id: string } }>("/api/providers/:id/credential", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const apiKey = await dependencies.credentials.getApiKey(request.params.id);
    if (!apiKey) return sendApiError(reply, 404, "CREDENTIAL_NOT_FOUND", "Provider 尚未配置 API Key");
    reply.header("Cache-Control", "no-store");
    return reply.send({ apiKey });
  });

  app.post("/api/providers", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = record(request.body);
    if (typeof body.id !== "string" || !validId(body.id)) return sendApiError(reply, 400, "INVALID_PROVIDER_ID", "Provider ID 格式无效");
    if (typeof body.revision !== "string" || !isRecord(body.provider)) return sendApiError(reply, 400, "INVALID_PROVIDER_REQUEST", "缺少 revision 或 Provider 配置");
    try {
      return reply.send(publicModelDocument(await runModelMutation(dependencies, () => dependencies.models.createProvider(body.id as string, body.provider as Record<string, unknown>, body.revision as string))));
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post("/api/providers/order", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = record(request.body);
    if (typeof body.revision !== "string" || !validIdList(body.providerIds)) {
      return sendApiError(reply, 400, "INVALID_PROVIDER_ORDER", "Provider 排序格式无效");
    }
    try {
      return reply.send(publicModelDocument(await runModelMutation(dependencies, () => dependencies.models.reorderProviders(body.providerIds as string[], body.revision as string))));
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!validId(request.params.id)) return sendApiError(reply, 400, "INVALID_PROVIDER_ID", "Provider ID 格式无效");
    const body = record(request.body);
    if (typeof body.revision !== "string" || !isRecord(body.provider)) return sendApiError(reply, 400, "INVALID_PROVIDER_REQUEST", "缺少 revision 或 Provider 配置");
    try {
      const updated = await runModelMutation(dependencies, async () => {
        const current = await dependencies.models.read();
        const providers = isRecord(current.value.providers) ? current.value.providers : {};
        const provider = hydrateRedacted(body.provider, providers[request.params.id]) as Record<string, unknown>;
        return dependencies.models.updateProvider(request.params.id, provider, body.revision as string);
      });
      return reply.send(publicModelDocument(updated));
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = record(request.body);
    if (typeof body.revision !== "string") return sendApiError(reply, 400, "REVISION_REQUIRED", "删除 Provider 必须携带 revision");
    try {
      const updated = await runModelMutation(dependencies, async () => {
        if ((await dependencies.agents.list()).some(({ profile }) => profile.defaultModel?.provider === request.params.id)) {
          throw new ModelReferenceInUseError("PROVIDER_IN_USE", "Provider 正被 Agent 默认模型引用");
        }
        return dependencies.models.removeProvider(request.params.id, body.revision as string);
      });
      return reply.send(publicModelDocument(updated));
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/rename", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = record(request.body);
    if (body.confirmed !== true) return sendApiError(reply, 400, "PROVIDER_RENAME_CONFIRMATION_REQUIRED", "改名前必须明确确认迁移引用");
    if (typeof body.id !== "string" || !validId(body.id)) return sendApiError(reply, 400, "INVALID_PROVIDER_ID", "Provider ID 格式无效");
    if (typeof body.revision !== "string") return sendApiError(reply, 400, "REVISION_REQUIRED", "改名必须携带 models.json revision");
    try {
      return reply.send(publicModelDocument(await runModelMutation(dependencies, () => dependencies.renameService.rename(request.params.id, body.id as string, body.revision as string))));
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.put<{ Params: { id: string; modelId: string } }>("/api/providers/:id/models/:modelId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = record(request.body);
    if (typeof body.revision !== "string" || !isRecord(body.model)) return sendApiError(reply, 400, "INVALID_MODEL_REQUEST", "缺少 revision 或模型配置");
    try {
      const updated = await runModelMutation(dependencies, async () => {
        const current = await dependencies.models.read();
        const providers = isRecord(current.value.providers) ? current.value.providers : {};
        const providerCandidate = providers[request.params.id];
        const provider = isRecord(providerCandidate) ? providerCandidate : {};
        const existing = Array.isArray(provider.models)
          ? provider.models.find((model) => isRecord(model) && model.id === request.params.modelId)
          : undefined;
        const model = hydrateRedacted(body.model, existing) as Record<string, unknown>;
        return dependencies.models.upsertModel(request.params.id, request.params.modelId, model, body.revision as string);
      });
      return reply.send(publicModelDocument(updated));
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/models/order", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = record(request.body);
    if (typeof body.revision !== "string" || !validModelIdList(body.modelIds)) {
      return sendApiError(reply, 400, "INVALID_MODEL_ORDER", "模型排序格式无效");
    }
    try {
      return reply.send(publicModelDocument(await runModelMutation(dependencies, () => dependencies.models.reorderModels(request.params.id, body.modelIds as string[], body.revision as string))));
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.delete<{ Params: { id: string; modelId: string } }>("/api/providers/:id/models/:modelId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = record(request.body);
    if (typeof body.revision !== "string") return sendApiError(reply, 400, "REVISION_REQUIRED", "删除模型必须携带 revision");
    try {
      const updated = await runModelMutation(dependencies, async () => {
        if ((await dependencies.agents.list()).some(({ profile }) => profile.defaultModel?.provider === request.params.id && profile.defaultModel.id === request.params.modelId)) {
          throw new ModelReferenceInUseError("MODEL_IN_USE", "模型正被 Agent 默认配置引用");
        }
        return dependencies.models.removeModel(request.params.id, request.params.modelId, body.revision as string);
      });
      return reply.send(publicModelDocument(updated));
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>("/api/providers/:id/credential", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = record(request.body);
    if (typeof body.revision !== "string" || typeof body.apiKey !== "string" || !body.apiKey) return sendApiError(reply, 400, "INVALID_CREDENTIAL", "缺少 revision 或 API Key");
    try {
      const credentialRevision = await dependencies.credentials.setApiKey(request.params.id, body.apiKey, body.revision);
      return reply.send({ credentialRevision, status: { providerId: request.params.id, type: "api_key", configured: true } });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id/credential", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = record(request.body);
    if (typeof body.revision !== "string") return sendApiError(reply, 400, "REVISION_REQUIRED", "删除凭证必须携带 revision");
    try {
      const credentialRevision = await dependencies.credentials.remove(request.params.id, body.revision);
      return reply.send({ credentialRevision, status: null });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/test", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!dependencies.testModels) return sendApiError(reply, 503, "MODEL_RUNTIME_UNAVAILABLE", "模型运行时尚未就绪");
    const body = record(request.body);
    const testRequest = parseModelTestRequest(body);
    if (!testRequest) return sendApiError(reply, 400, "INVALID_MODEL_TEST_REQUEST", "测试请求格式无效");
    try {
      return reply.send(await dependencies.testModels(request.params.id, testRequest));
    } catch (error) {
      if (error instanceof ModelConnectionTestError) {
        const status = error.code === "PROVIDER_NOT_FOUND" ? 404 : error.code === "MODEL_TEST_IN_PROGRESS" ? 409 : 400;
        return sendApiError(reply, status, error.code, error.message);
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/discover-models", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!dependencies.discoverModels) return sendApiError(reply, 503, "MODEL_DISCOVERY_UNAVAILABLE", "模型发现服务尚未就绪");
    try {
      return reply.send(await dependencies.discoverModels(request.params.id));
    } catch (error) {
      if (error instanceof ProviderModelDiscoveryError) {
        const status = error.code === "PROVIDER_NOT_FOUND"
          ? 404
          : error.code === "UNSUPPORTED_PROVIDER_API"
            ? 422
            : error.code === "MODEL_DISCOVERY_IN_PROGRESS"
              ? 409
              : error.code === "INVALID_PROVIDER_BASE_URL"
                ? 400
                : 502;
        return sendApiError(reply, status, error.code, error.message);
      }
      throw error;
    }
  });
}

/**
 * 校验模型连接测试请求，防止浏览器伪造未保存的配置。
 *
 * @param body 原始请求体
 */
function parseModelTestRequest(body: Record<string, unknown>): ModelConnectionTestRequest | undefined {
  if (body.scope === "all") return { scope: "all" };
  if (body.scope === "current" && typeof body.modelId === "string" && body.modelId) {
    return { scope: "current", modelId: body.modelId };
  }
  return undefined;
}

function sendProviderError(reply: FastifyReply, error: unknown) {
  if (error instanceof ModelReferenceInUseError) return sendApiError(reply, 409, error.code, error.message);
  if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
  if (error instanceof ProviderAlreadyExistsError) return sendApiError(reply, 409, "PROVIDER_ID_EXISTS", error.message);
  if (error instanceof ProviderNotFoundError) return sendApiError(reply, 404, "PROVIDER_NOT_FOUND", error.message);
  if (error instanceof ModelConfigurationValidationError) {
    return sendApiError(reply, 422, "MODEL_SCHEMA_INVALID", error.message, { diagnostics: error.diagnostics });
  }
  return sendApiError(reply, 400, "PROVIDER_INVALID", error instanceof Error ? error.message : "Provider 操作失败");
}

class ModelReferenceInUseError extends Error {
  constructor(readonly code: "PROVIDER_IN_USE" | "MODEL_IN_USE", message: string) {
    super(message);
  }
}

function runModelMutation<T>(dependencies: ProviderRouteDependencies, operation: () => Promise<T>): Promise<T> {
  return dependencies.runModelMutation?.(operation) ?? operation();
}

/** Provider 成功响应统一投影为可回写占位值，任何保留式未知字段都不能泄露秘密。 */
function publicModelDocument<T extends { value: unknown }>(document: T): T {
  return { ...document, value: scrubSecrets(document.value) } as T;
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value);
}

function validIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && validId(item));
}

/** Pi 模型 ID 可包含斜杠、冒号等 Provider ID 不允许的字符。 */
function validModelIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
