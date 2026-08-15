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
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

interface AuthServiceOptions {
  now?: () => Date;
  identityRepository?: IdentityRepository;
}

export interface AuthService {
  login(password: string, clientKey: string): Promise<
    | { status: "authenticated"; token: string }
    | { status: "invalid" }
    | { status: "rate_limited" }
    | { status: "not_initialized" }
  >;
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
  const identity = createIdentityService(repository, options);

  return {
    login: identity.login,
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

  app.post("/api/login", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    if (Object.keys(body).length !== 2 || typeof body.password !== "string" || typeof body.remember !== "boolean") {
      return sendApiError(reply, 400, "INVALID_LOGIN_REQUEST", "请提供访问密码和保持登录选项");
    }
    const result = await dependencies.authService.login(body.password, request.ip);

    if (result.status === "rate_limited") {
      return sendApiError(reply, 429, "LOGIN_RATE_LIMITED", "登录尝试过于频繁，请稍后再试");
    }
    if (result.status === "not_initialized") {
      return sendApiError(reply, 409, "NOT_INITIALIZED", "请先完成服务初始化");
    }
    if (result.status === "invalid") {
      return sendApiError(reply, 401, "INVALID_CREDENTIALS", "访问密码错误");
    }

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
