import type { FastifyInstance } from "fastify";

import type {
  AigcCreateChannelInput,
  AigcUpdateChannelInput,
} from "../../shared/aigc-contracts";
import type { AigcConnectionManagementService } from "../aigc/aigc-connection-management-service";
import type { AigcConnectionValidation } from "../aigc/aigc-connection-validation";
import type { CredentialService } from "../configuration/credential-service";
import { VersionConflictError } from "../configuration/versioned-json-store";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface AigcChannelRouteDependencies {
  authService: AuthService;
  management: AigcConnectionManagementService;
  validation: AigcConnectionValidation;
  credentials: CredentialService;
  isChannelInUse?: (channelId: string) => Promise<boolean>;
}

/** 注册配置中心的能力扩展 AIGC 渠道接口。 */
export function registerAigcChannelRoutes(app: FastifyInstance, dependencies: AigcChannelRouteDependencies): void {
  app.get("/api/capabilities/aigc/channels", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    return reply.send(await dependencies.management.document());
  });

  app.post("/api/capabilities/aigc/channels", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body
      || typeof body.configRevision !== "string"
      || typeof body.credentialRevision !== "string"
      || !isRecord(body.channel)
      || (body.apiKey !== undefined && typeof body.apiKey !== "string")) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "AIGC 渠道配置格式无效");
    }
    try {
      await dependencies.management.add(body as unknown as AigcCreateChannelInput);
      return reply.code(201).send(await dependencies.management.document());
    } catch (error) {
      return sendAigcChannelError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/capabilities/aigc/channels/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body
      || typeof body.configRevision !== "string"
      || typeof body.credentialRevision !== "string"
      || !isRecord(body.channel)
      || !isCredentialMutation(body.credential)) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "AIGC 渠道配置格式无效");
    }
    try {
      await dependencies.management.update(request.params.id, body as unknown as AigcUpdateChannelInput);
      return reply.send(await dependencies.management.document());
    } catch (error) {
      return sendAigcChannelError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/capabilities/aigc/channels/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.configRevision !== "string" || typeof body.credentialRevision !== "string") {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "缺少配置版本");
    }
    try {
      if (await dependencies.isChannelInUse?.(request.params.id)) {
        return sendApiError(reply, 409, "VALIDATION_FAILED", "该渠道仍被 AIGC 接口引用");
      }
      await dependencies.management.remove(request.params.id, body.configRevision, body.credentialRevision);
      return reply.code(204).send();
    } catch (error) {
      return sendAigcChannelError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/capabilities/aigc/channels/:id/test", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    try {
      const document = await dependencies.management.document();
      const channel = document.channels.find((candidate) => candidate.id === request.params.id);
      if (!channel) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 渠道不存在");
      const apiKey = await dependencies.credentials.getApiKey(channel.id);
      return reply.send(await dependencies.validation.test(channel, apiKey));
    } catch (error) {
      return sendAigcChannelError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/capabilities/aigc/channels/:id/credential", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const apiKey = await dependencies.credentials.getApiKey(request.params.id);
    if (!apiKey) return sendApiError(reply, 404, "CREDENTIAL_NOT_FOUND", "AIGC 渠道尚未配置 API Key");
    return reply.header("Cache-Control", "no-store").send({ apiKey });
  });
}

/** 校验凭证操作的判别字段与替换值。 */
function isCredentialMutation(value: unknown): boolean {
  if (!isRecord(value) || !["keep", "replace", "remove"].includes(String(value.action))) return false;
  return value.action !== "replace" || (typeof value.apiKey === "string" && Boolean(value.apiKey));
}

function sendAigcChannelError(reply: Parameters<typeof sendApiError>[0], error: unknown) {
  if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
  return sendApiError(reply, 400, "VALIDATION_FAILED", error instanceof Error ? error.message : "AIGC 渠道配置无效");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
