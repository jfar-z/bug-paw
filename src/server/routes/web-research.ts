import type { FastifyInstance } from "fastify";

import type { SearchProviderConfig, SearchProviderTemplate, WebResearchConfig, WebResearchSettingsDocument } from "../../shared/web-research-contracts";
import type { CredentialService } from "../configuration/credential-service";
import { VersionConflictError } from "../configuration/versioned-json-store";
import { EgressProfileRegistry } from "../web-research/egress-profile-registry";
import { ManagedSearchProviderRegistry } from "../web-research/managed-search-provider-registry";
import type { WebResearchConfigService } from "../web-research/web-research-config-service";
import type { WebResearchProviderManagementService } from "../web-research/web-research-provider-management-service";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface WebResearchRouteDependencies {
  authService: AuthService;
  configs: WebResearchConfigService;
  credentials: CredentialService;
  management: WebResearchProviderManagementService;
  managedProviders: ManagedSearchProviderRegistry;
  service: { testProvider(providerId: string): Promise<void> };
  refreshRuntime: () => Promise<unknown>;
  egressProfiles: EgressProfileRegistry;
}

const DIRECT_PROVIDER_TEMPLATES: SearchProviderTemplate[] = [
  { id: "custom-searxng", name: "自定义 SearXNG", type: "searxng", connectionMode: "custom" },
  { id: "bocha", name: "博查 Web Search", type: "bocha", connectionMode: "official" },
  { id: "tavily", name: "Tavily Search", type: "tavily", connectionMode: "official" },
];

/** 注册能力扩展中的联网搜索配置、实例和凭证接口。 */
export function registerWebResearchRoutes(app: FastifyInstance, dependencies: WebResearchRouteDependencies): void {
  app.get("/api/capabilities/web-research", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    return reply.send(await documentWithProfiles(dependencies));
  });

  app.patch("/api/capabilities/web-research", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    const body = request.body as { revision?: unknown; config?: unknown };
    if (typeof body?.revision !== "string" || !isRecord(body.config)) return sendApiError(reply, 400, "VALIDATION_FAILED", "联网搜索配置格式无效");
    try {
      const config = await dependencies.configs.validate(body.config as unknown as WebResearchConfig);
      await assertEnabledProviderCredentials(config, dependencies.credentials);
      await dependencies.configs.update(config, body.revision);
      await dependencies.refreshRuntime();
      return reply.send(await documentWithProfiles(dependencies));
    } catch (error) {
      return sendManagedError(reply, error);
    }
  });

  app.post("/api/capabilities/web-research/providers", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string" || !isRecord(body.provider)) return sendApiError(reply, 400, "VALIDATION_FAILED", "搜索服务配置格式无效");
    try {
      await dependencies.management.add(body.provider as unknown as SearchProviderConfig, body.revision);
      return reply.code(201).send(await documentWithProfiles(dependencies));
    } catch (error) {
      return sendManagedError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/capabilities/web-research/providers/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.configRevision !== "string" || typeof body.credentialRevision !== "string") {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "缺少配置版本");
    }
    try {
      await dependencies.management.remove(request.params.id, body.configRevision, body.credentialRevision);
      await dependencies.refreshRuntime();
      return reply.code(204).send();
    } catch (error) {
      return sendManagedError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/capabilities/web-research/providers/:id/test", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    try {
      await dependencies.service.testProvider(request.params.id);
      return reply.send({ ok: true, message: "搜索服务连接正常" });
    } catch {
      return reply.send({ ok: false, message: "搜索服务当前不可用，请检查配置和服务状态" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/capabilities/web-research/providers/:id/credential", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const apiKey = await dependencies.credentials.getApiKey(request.params.id);
    if (!apiKey) return sendApiError(reply, 404, "CREDENTIAL_NOT_FOUND", "搜索服务尚未配置 API Key");
    return reply.header("Cache-Control", "no-store").send({ apiKey });
  });

  app.put<{ Params: { id: string } }>("/api/capabilities/web-research/providers/:id/credential", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string" || typeof body.apiKey !== "string" || !body.apiKey) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "搜索服务凭证格式无效");
    }
    if (!(await providerExists(dependencies, request.params.id))) return sendApiError(reply, 404, "PROVIDER_NOT_FOUND", "搜索服务不存在");
    try {
      const credentialRevision = await dependencies.credentials.setApiKey(request.params.id, body.apiKey, body.revision);
      return reply.header("Cache-Control", "no-store").send({ credentialRevision, status: { providerId: request.params.id, type: "api_key", configured: true } });
    } catch (error) {
      return sendManagedError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/capabilities/web-research/providers/:id/credential", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string") return sendApiError(reply, 400, "VALIDATION_FAILED", "缺少凭证版本");
    try {
      const { config } = await dependencies.configs.read();
      const provider = config.searchProviders.find((candidate) => candidate.id === request.params.id);
      if (config.enabled && provider?.enabled) throw new TypeError("请先停用搜索服务，再删除 API Key");
      const credentialRevision = await dependencies.credentials.remove(request.params.id, body.revision);
      return reply.header("Cache-Control", "no-store").send({ credentialRevision, status: null });
    } catch (error) {
      return sendManagedError(reply, error);
    }
  });
}

/** 全局能力启用时，所有启用的直连实例都必须具备独立凭证。 */
async function assertEnabledProviderCredentials(config: WebResearchConfig, credentials: CredentialService): Promise<void> {
  if (!config.enabled) return;
  const configured = new Set((await credentials.list()).map((status) => status.providerId));
  const missing = config.searchProviders.find((provider) => provider.enabled && provider.type !== "searxng" && !configured.has(provider.id));
  if (missing) throw new TypeError(`搜索服务“${missing.name}”尚未配置 API Key`);
}

async function documentWithProfiles(dependencies: WebResearchRouteDependencies): Promise<WebResearchSettingsDocument> {
  const [document, egressProfiles, credentials, credentialRevision] = await Promise.all([
    dependencies.configs.read(),
    dependencies.egressProfiles.listSummaries(),
    dependencies.credentials.list(),
    dependencies.credentials.getRevision(),
  ]);
  return {
    ...document,
    egressProfiles,
    providerTemplates: [...dependencies.managedProviders.listTemplates(), ...DIRECT_PROVIDER_TEMPLATES],
    credentials,
    credentialRevision,
  };
}

async function providerExists(dependencies: WebResearchRouteDependencies, providerId: string): Promise<boolean> {
  return (await dependencies.configs.read()).config.searchProviders.some((provider) => provider.id === providerId);
}

function sendManagedError(reply: Parameters<typeof sendApiError>[0], error: unknown) {
  if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
  return sendApiError(reply, 400, "VALIDATION_FAILED", error instanceof Error ? error.message : "搜索服务配置无效");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
