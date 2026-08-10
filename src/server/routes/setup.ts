import type { FastifyInstance } from "fastify";
import { hashPassword } from "../auth";
import { type StoredProviderConfig } from "../config";
import { ConfigTransaction } from "../configuration/config-transaction";
import { createVersionedJsonStore } from "../configuration/versioned-json-store";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { createIdentityRepository, type IdentityRepository } from "../identity/identity-repository";
import type { DataPaths } from "../paths";
import { join } from "node:path";
import { sendApiError } from "./http";

interface SetupRouteDependencies {
  paths: DataPaths;
  now?: () => Date;
  identityRepository?: IdentityRepository;
  onInitialized?: () => Promise<void>;
}

interface SetupBody {
  password: string;
  confirmPassword: string;
  provider: StoredProviderConfig;
}

/**
 * 注册只允许执行一次的本地初始化接口。
 */
export function registerSetupRoutes(app: FastifyInstance, dependencies: SetupRouteDependencies): void {
  const now = dependencies.now ?? (() => new Date());
  const ownedDatabase = dependencies.identityRepository ? undefined : openDatabase(dependencies.paths.databaseFile);
  if (ownedDatabase) {
    runMigrations(ownedDatabase);
    app.addHook("onClose", async () => ownedDatabase.close());
  }
  const identities = dependencies.identityRepository ?? createIdentityRepository(ownedDatabase!);

  app.post("/api/setup", async (request, reply) => {
    if (await identities.getUser("owner")) {
      return sendApiError(reply, 409, "ALREADY_INITIALIZED", "服务已经完成初始化");
    }

    const body = parseSetupBody(request.body);
    if (!body) {
      return sendApiError(reply, 400, "INVALID_SETUP", "初始化信息不完整或格式不正确");
    }

    const password = await hashPassword(body.password);
    const createdAt = now().toISOString();
    const authPath = join(dependencies.paths.piDir, "auth.json");
    const modelsPath = join(dependencies.paths.piDir, "models.json");
    const settingsPath = join(dependencies.paths.piDir, "settings.json");
    const [authDocument, modelsDocument, settingsDocument] = await Promise.all([
      createVersionedJsonStore<Record<string, unknown>>(authPath).read(),
      createVersionedJsonStore<Record<string, unknown>>(modelsPath).read(),
      createVersionedJsonStore<Record<string, unknown>>(settingsPath).read(),
    ]);
    const providerNode = {
      name: "OpenAI Compatible",
      baseUrl: body.provider.baseUrl,
      api: "openai-completions",
      models: [
        {
          id: body.provider.defaultModel,
          name: body.provider.defaultModel,
          api: "openai-completions",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ],
    };
    const currentModels = modelsDocument.value ?? { providers: {} };
    const currentProviders = isRecord(currentModels.providers) ? currentModels.providers : {};
    await new ConfigTransaction({
      rootDir: dependencies.paths.rootDir,
      transactionDir: dependencies.paths.transactionDir,
    }).run([
      {
        path: authPath,
        expectedRevision: authDocument.revision,
        nextContent: `${JSON.stringify({ ...(authDocument.value ?? {}), [body.provider.type]: { type: "api_key", key: body.provider.apiKey } })}\n`,
        sensitive: true,
      },
      {
        path: modelsPath,
        expectedRevision: modelsDocument.revision,
        nextContent: `${JSON.stringify({ ...currentModels, providers: { ...currentProviders, [body.provider.type]: providerNode } })}\n`,
        sensitive: false,
      },
      {
        path: settingsPath,
        expectedRevision: settingsDocument.revision,
        nextContent: `${JSON.stringify({ ...(settingsDocument.value ?? {}), defaultProvider: body.provider.type, defaultModel: body.provider.defaultModel })}\n`,
        sensitive: false,
      },
    ]);
    await identities.initializeUser({
      id: "owner",
      password,
      displayName: "本地管理员",
      now: createdAt,
    });
    await dependencies.onInitialized?.();
    return reply.code(201).send({ initialized: true });
  });
}

function parseSetupBody(value: unknown): SetupBody | undefined {
  if (!isRecord(value) || !isRecord(value.provider) || !hasOnlyKeys(value, ["password", "confirmPassword", "provider"])) {
    return undefined;
  }

  const password = typeof value.password === "string" ? value.password : "";
  const confirmPassword = typeof value.confirmPassword === "string" ? value.confirmPassword : "";
  const type = readTrimmedString(value.provider.type);
  const apiKey = readTrimmedString(value.provider.apiKey);
  const defaultModel = readTrimmedString(value.provider.defaultModel);
  const baseUrl = readOptionalUrl(value.provider.baseUrl);

  if (
    password.length < 12 ||
    password.length > 256 ||
    password !== confirmPassword ||
    !type ||
    !apiKey ||
    !defaultModel ||
    baseUrl === null
  ) {
    return undefined;
  }

  return {
    password,
    confirmPassword,
    provider: {
      type,
      apiKey,
      defaultModel,
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}

/**
 * 校验初始化请求只包含当前协议允许的顶层字段。
 *
 * @param value 请求对象
 * @param keys 允许字段
 */
function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && Object.keys(value).length === keys.length;
}

function readOptionalUrl(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const result = value.trim();
  return result.length > 0 ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
