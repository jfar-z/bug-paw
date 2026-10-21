import { join } from "node:path";
import { createTwoFactorService, type TwoFactorService } from "../identity/two-factor-service";
import type {} from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { DataPaths } from "../paths";
import { processAvatarImage } from "../avatar/avatar-image-processor";
import { receiveAvatarUpload } from "../avatar/avatar-upload";
import { DomainError } from "../core/errors";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { createIdentityRepository, type IdentityRepository } from "../identity/identity-repository";
import { createIdentityService, type IdentityService } from "../identity/identity-service";
import { statusForDomainError } from "../http/error-handler";
import { sendApiError } from "./http";

const SESSION_COOKIE = "pi_agent_session";
const CHALLENGE_COOKIE = "pi_agent_challenge";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

interface AuthServiceOptions {
  now?: () => Date;
  identityRepository?: IdentityRepository;
}

export interface AuthService {
  login: IdentityService["login"];
  twoFactor: TwoFactorService;
  logout(token: string | undefined): Promise<void>;
  isAuthenticated(request: FastifyRequest): Promise<boolean>;
  isInitialized(): Promise<boolean>;
  getProfile: IdentityService["getProfile"];
  updateProfile: IdentityService["updateProfile"];
  dispose?(): void;
}

/**
 * 创建单用户认证服务，凭证与会话状态均从持久化目录读取。
 */
export function createAuthService(paths: DataPaths, options: AuthServiceOptions = {}): AuthService {
  let repository = options.identityRepository;
  let dispose: () => void = () => undefined;
  if (!repository) {
    const database = openDatabase(paths.databaseFile);
    runMigrations(database);
    repository = createIdentityRepository(database);
    dispose = () => database.close();
  }
  const twoFactor = createTwoFactorService(repository, join(paths.appDir, "totp-encryption.key"), options.now ?? (() => new Date()));
  const identity = createIdentityService(repository, { ...options, twoFactor });

  return {
    login: identity.login,
    twoFactor,
    logout: identity.logout,
    isAuthenticated: (request) => identity.authenticateToken(request.cookies[SESSION_COOKIE]),
    isInitialized: identity.isInitialized,
    getProfile: identity.getProfile,
    updateProfile: identity.updateProfile,
    dispose,
  };
}

interface AuthRouteDependencies {
  authService: AuthService;
  paths: DataPaths;
}

type AvatarMediaType = "image/png" | "image/jpeg" | "image/webp";

/** 以同目录临时文件原子写入头像，并保证任意失败分支不残留临时文件。 */
export async function persistAvatarFile(finalPath: string, content: Buffer): Promise<void> {
  const temporaryPath = `${finalPath}.tmp`;
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, finalPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * 注册登录、退出和当前身份接口。
 */
export function registerAuthRoutes(app: FastifyInstance, dependencies: AuthRouteDependencies): void {
  app.addHook("onClose", async () => dependencies.authService.dispose?.());

  // 身份接口的成功、错误和验证码响应均不得被浏览器或代理缓存。
  app.addHook("onSend", async (request, reply, payload) => {
    if (/^\/api\/(?:v1\/)?(?:login|logout|security)(?:\/|\?|$)/.test(request.url)) reply.header("Cache-Control", "no-store");
    return payload;
  });
  // 已建立的事件订阅也属于旧会话；轮换后主动断开，防止继续接收私有事件。
  const streams = new Set<import("node:http").ServerResponse>();
  app.addHook("onRequest", async (request, reply) => {
    if (request.cookies[SESSION_COOKIE] && /^\/api\/(?:v1\/)?(?:sessions|configuration\/tasks)\/[^/]+\/events(?:\?|$)/.test(request.url)) {
      streams.add(reply.raw);
      reply.raw.once("close", () => streams.delete(reply.raw));
    }
  });
  const closeStreams = () => { for (const stream of streams) stream.destroy(); streams.clear(); };
  registerTwoFactorRoutes(app, dependencies.authService, closeStreams);

  app.post("/api/login", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    if (Object.keys(body).length !== 2 || typeof body.password !== "string" || typeof body.remember !== "boolean") {
      return sendApiError(reply, 400, "INVALID_LOGIN_REQUEST", "请提供访问密码和保持登录选项");
    }
    const result = await dependencies.authService.login(body.password, request.ip, body.remember);

    if (result.status === "rate_limited") {
      return sendApiError(reply, 429, "LOGIN_RATE_LIMITED", "登录尝试过于频繁，请稍后再试");
    }
    if (result.status === "not_initialized") {
      return sendApiError(reply, 409, "NOT_INITIALIZED", "请先完成服务初始化");
    }
    if (result.status === "invalid") {
      return sendApiError(reply, 401, "INVALID_CREDENTIALS", "访问密码错误");
    }

    if (result.status === "second_factor_required") {
      reply.setCookie(CHALLENGE_COOKIE, result.challenge, { path: "/", httpOnly: true, sameSite: "strict", secure: request.protocol === "https", maxAge: 300 });
      return reply.send({ authenticated: false, requiresTwoFactor: true, expiresAt: result.expiresAt });
    }
    if (request.cookies[CHALLENGE_COOKIE]) reply.clearCookie(CHALLENGE_COOKIE, { path: "/" });
    reply.setCookie(SESSION_COOKIE, result.token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      ...(body.remember ? { maxAge: SESSION_DURATION_MS / 1000 } : {}),
    });
    return reply.send({ authenticated: true });
  });

  app.post("/api/logout", async (request, reply) => {
    await dependencies.authService.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "strict" });
    reply.clearCookie(CHALLENGE_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/me", async (request, reply) => {
    if (!(await dependencies.authService.isAuthenticated(request))) {
      return sendApiError(reply, 401, "AUTH_REQUIRED", "请先登录");
    }
    return reply.send({ authenticated: true });
  });

  app.get("/api/profile", async (request, reply) => {
    if (!(await requireUser(request, reply, dependencies.authService))) return;
    const profile = await dependencies.authService.getProfile();
    if (!profile) return sendApiError(reply, 404, "PROFILE_NOT_FOUND", "个人资料不存在");
    return reply.send({ revision: profile.revision, profile: toPublicProfile(profile) });
  });

  app.patch("/api/profile", async (request, reply) => {
    if (!(await requireUser(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (typeof body.revision !== "string" || !displayName || displayName.length > 64) {
      return sendApiError(reply, 400, "INVALID_PROFILE", "显示名长度应为 1 到 64 个字符");
    }
    try {
      const updated = await dependencies.authService.updateProfile(body.revision, { displayName });
      return reply.send({ revision: updated.revision, profile: toPublicProfile(updated) });
    } catch (error) {
      if (isDomainCode(error, "VERSION_CONFLICT")) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
      throw error;
    }
  });

  app.get("/api/profile/avatar", async (request, reply) => {
    if (!(await requireUser(request, reply, dependencies.authService))) return;
    const profile = await dependencies.authService.getProfile();
    if (!profile?.avatar) return sendApiError(reply, 404, "AVATAR_NOT_FOUND", "未配置图片头像");
    try {
      const content = await readFile(profile.avatar.path);
      return reply.header("Cache-Control", "private, max-age=31536000, immutable").type(profile.avatar.mediaType).send(content);
    } catch {
      return sendApiError(reply, 404, "AVATAR_NOT_FOUND", "头像文件不存在");
    }
  });

  app.post<{ Querystring: { revision?: string } }>("/api/profile/avatar", async (request, reply) => {
    if (!(await requireUser(request, reply, dependencies.authService))) return;
    if (typeof request.query.revision !== "string") {
      return sendApiError(reply, 400, "INVALID_AVATAR", "请上传头像图片并携带版本号");
    }
    try {
      const upload = await receiveAvatarUpload(request);
      let response: { revision: string; profile: ReturnType<typeof toPublicProfile> };
      try {
        const processed = await processAvatarImage(upload.sourcePath, upload.crop);
        const current = await dependencies.authService.getProfile();
        if (!current) throw new DomainError("PROFILE_NOT_FOUND", "个人资料不存在");
        const token = randomUUID();
        const finalPath = `${dependencies.paths.userAvatarFile}-${token}`;
        await persistAvatarFile(finalPath, processed.content);
        try {
          const updated = await dependencies.authService.updateProfile(request.query.revision, {
            avatar: { path: finalPath, mediaType: processed.mediaType },
          });
          if (current.avatar && current.avatar.path !== finalPath) {
            // Profile 已指向新头像，旧文件清理失败不应回滚成功响应。
            await rm(current.avatar.path, { force: true }).catch(() => undefined);
          }
          response = { revision: updated.revision, profile: toPublicProfile(updated) };
        } catch (error) {
          await rm(finalPath, { force: true });
          throw error;
        }
      } finally {
        await upload.cleanup();
      }
      return reply.send(response);
    } catch (error) {
      if (isDomainCode(error, "VERSION_CONFLICT")) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
      if (error instanceof DomainError) {
        return sendApiError(reply, statusForDomainError(error.code), error.code, error.message);
      }
      throw error;
    }
  });
}

async function requireUser(request: FastifyRequest, reply: import("fastify").FastifyReply, authService: AuthService): Promise<boolean> {
  if (await authService.isAuthenticated(request)) return true;
  sendApiError(reply, 401, "AUTH_REQUIRED", "请先登录");
  return false;
}

function toPublicProfile(profile: Awaited<ReturnType<AuthService["getProfile"]>> & {}): { displayName: string; avatar?: { kind: "image"; revision: string; mediaType: AvatarMediaType } } {
  const avatar = profile.avatar;
  return {
    displayName: profile.displayName || "本地管理员",
    ...(avatar ? { avatar: { kind: "image" as const, revision: profile.revision, mediaType: avatar.mediaType } } : {}),
  };
}

function isDomainCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 注册两步登录与安全设置接口，管理操作必须持有正式会话。 */
function registerTwoFactorRoutes(app: FastifyInstance, auth: AuthService, closeStreams: () => void): void {
  app.post("/api/login/totp", async (request, reply) => {
    const body = securityBody(request.body, ["code", "recovery"]);
    const result = auth.twoFactor.completeLogin(request.cookies[CHALLENGE_COOKIE], textField(body, "code", 128), recoveryField(body));
    setSession(reply, request, result);
    reply.clearCookie(CHALLENGE_COOKIE, { path: "/" });
    return { authenticated: true };
  });
  app.get("/api/security/totp", async (request) => auth.twoFactor.status(request.cookies[SESSION_COOKIE]));
  app.post("/api/security/totp/setup", async (request) => {
    const body = securityBody(request.body, ["password"]);
    return auth.twoFactor.beginSetup(request.cookies[SESSION_COOKIE], textField(body, "password", 1024));
  });
  app.delete("/api/security/totp/setup", async (request, reply) => {
    auth.twoFactor.cancelSetup(request.cookies[SESSION_COOKIE]);
    return reply.code(204).send();
  });
  app.post("/api/security/totp/confirm", async (request, reply) => {
    const body = securityBody(request.body, ["code"]);
    const result = auth.twoFactor.confirmSetup(request.cookies[SESSION_COOKIE], textField(body, "code", 6));
    setSession(reply, request, result);
    closeStreams();
    return { recoveryCodes: result.recoveryCodes };
  });
  for (const action of ["disable", "recovery"] as const) {
    app.post(`/api/security/totp/${action}`, async (request, reply) => {
      const body = securityBody(request.body, ["password", "code", "recovery"]);
      const result = await auth.twoFactor.manage(request.cookies[SESSION_COOKIE], {
        password: textField(body, "password", 1024), code: textField(body, "code", 128), recovery: recoveryField(body),
      }, action);
      setSession(reply, request, result);
      closeStreams();
      return { recoveryCodes: result.recoveryCodes };
    });
  }
}

/** Cookie 只由完整认证和成功的身份事务签发。 */
function setSession(reply: import("fastify").FastifyReply, request: FastifyRequest, result: { token: string; remember: boolean }): void {
  reply.setCookie(SESSION_COOKIE, result.token, { path: "/", httpOnly: true, sameSite: "strict", secure: request.protocol === "https", ...(result.remember ? { maxAge: SESSION_DURATION_MS / 1000 } : {}) });
}

function securityBody(value: unknown, fields: string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new DomainError("VALIDATION_FAILED", "认证请求包含无效字段");
  return value;
}
function textField(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > max) throw new DomainError("VALIDATION_FAILED", "请提供完整且长度有效的认证凭据");
  return value;
}
function recoveryField(body: Record<string, unknown>): boolean {
  if (body.recovery !== undefined && typeof body.recovery !== "boolean") throw new DomainError("VALIDATION_FAILED", "恢复码选项必须为布尔值");
  return body.recovery === true;
}
