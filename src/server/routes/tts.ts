import type { FastifyInstance } from "fastify";

import type { TtsProfileInput } from "../../shared/tts-contracts";
import type { TtsCustomParameters } from "../../shared/tts-custom-parameters";
import { isTtsResponseFormat, normalizeTtsCustomParameters } from "../../shared/tts-custom-parameters";
import type { TtsConfigService } from "../tts/tts-config-service";
import type { TtsSynthesisService } from "../tts/tts-synthesis-service";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface TtsRouteDependencies {
  authService: AuthService;
  configs: TtsConfigService;
  synthesize: Pick<TtsSynthesisService, "synthesize">;
  isProfileInUse(profileId: string): Promise<boolean>;
  getAgentTtsProfile(agentId: string): Promise<{
    profileId: string;
    voice?: string;
    customParameters?: TtsCustomParameters;
  } | undefined>;
}

/** 注册语音合成配置管理接口。 */
export function registerTtsRoutes(app: FastifyInstance, dependencies: TtsRouteDependencies): void {
  app.get("/api/capabilities/tts", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    return reply.send(await dependencies.configs.list());
  });

  app.get<{ Params: { id: string } }>("/api/capabilities/tts/:id/credential", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const apiKey = (await dependencies.configs.getPrivate(request.params.id))?.apiKey;
    if (!apiKey) return sendApiError(reply, 404, "CREDENTIAL_NOT_FOUND", "语音配置尚未配置 API Key");
    reply.header("Cache-Control", "no-store");
    return reply.send({ apiKey });
  });

  app.post("/api/capabilities/tts", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      const input = readInput(request.body);
      if (!input) return sendApiError(reply, 400, "VALIDATION_FAILED", "语音配置格式无效");
      const created = await dependencies.configs.create(input);
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send(created);
    } catch (error) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", error instanceof Error ? error.message : "语音配置无效");
    }
  });

  app.patch<{ Params: { id: string } }>("/api/capabilities/tts/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    try {
      const input = readInput(body);
      if (!body || typeof body.revision !== "string" || !input) return sendApiError(reply, 400, "VALIDATION_FAILED", "语音配置格式无效");
      const updated = await dependencies.configs.update(request.params.id, input, body.revision);
      reply.header("Cache-Control", "no-store");
      return reply.send(updated);
    } catch (error) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", error instanceof Error ? error.message : "语音配置无效");
    }
  });

  app.delete<{ Params: { id: string } }>("/api/capabilities/tts/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string") return sendApiError(reply, 400, "VALIDATION_FAILED", "缺少配置版本");
    if (await dependencies.isProfileInUse(request.params.id)) return sendApiError(reply, 409, "MODEL_IN_USE", "语音配置正被 Agent 使用");
    try {
      await dependencies.configs.remove(request.params.id, body.revision);
      return reply.code(204).send();
    } catch (error) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", error instanceof Error ? error.message : "语音配置无效");
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/tts", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.input !== "string") return sendApiError(reply, 400, "VALIDATION_FAILED", "语音文本格式无效");
    const settings = await dependencies.getAgentTtsProfile(request.params.id);
    if (!settings) return sendApiError(reply, 409, "MODEL_IN_USE", "Agent 未配置语音模型");
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    // 浏览器停止朗读或切换上下文时会取消响应，必须同步终止上游生成。
    reply.raw.once("close", () => controller.abort());
    try {
      const audio = await dependencies.synthesize.synthesize(settings.profileId, body.input, controller.signal, {
        voice: settings.voice,
        customParameters: settings.customParameters,
      });
      return reply.type(audio.mediaType).header("Cache-Control", "no-store").send(audio.content);
    } catch (error) {
      if (controller.signal.aborted) return;
      return sendApiError(reply, 502, "VALIDATION_FAILED", "语音合成服务暂时不可用");
    }
  });
}

function readInput(value: unknown): TtsProfileInput | undefined {
  if (!isRecord(value)
    || typeof value.name !== "string"
    || typeof value.baseUrl !== "string"
    || typeof value.model !== "string"
    || typeof value.voice !== "string"
    || typeof value.apiKey !== "string"
    || !isTtsResponseFormat(value.responseFormat)) return undefined;
  return {
    name: value.name,
    baseUrl: value.baseUrl,
    model: value.model,
    voice: value.voice,
    apiKey: value.apiKey,
    responseFormat: value.responseFormat,
    customParameters: normalizeTtsCustomParameters(value.customParameters ?? {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
