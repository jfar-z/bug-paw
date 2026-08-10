import type {} from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { DataPaths } from "../paths";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { createIdentityRepository, type IdentityRepository } from "../identity/identity-repository";
import { createIdentityService, type IdentityService } from "../identity/identity-service";
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
    if (!request.isMultipart() || typeof request.query.revision !== "string") {
      return sendApiError(reply, 400, "INVALID_AVATAR", "请上传头像图片并携带版本号");
    }
    try {
      const part = await request.file({ limits: { files: 1, fileSize: 2 * 1024 * 1024 } });
      if (!part) return sendApiError(reply, 400, "AVATAR_REQUIRED", "请选择头像图片");
      const content = await part.toBuffer();
      const mediaType = detectImageType(content);
      if (!mediaType) return sendApiError(reply, 415, "INVALID_AVATAR_TYPE", "仅支持 PNG、JPEG 或 WebP 图片");
      const current = await dependencies.authService.getProfile();
      if (!current) return sendApiError(reply, 404, "PROFILE_NOT_FOUND", "个人资料不存在");
      const token = randomUUID();
      const finalPath = `${dependencies.paths.userAvatarFile}-${token}`;
      const temporaryPath = `${finalPath}.tmp`;
      await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, finalPath);
      try {
        const updated = await dependencies.authService.updateProfile(request.query.revision, {
          avatar: { path: finalPath, mediaType },
        });
        if (current.avatar && current.avatar.path !== finalPath) {
          await rm(current.avatar.path, { force: true }).catch(() => undefined);
        }
        return reply.send({ revision: updated.revision, profile: toPublicProfile(updated) });
      } catch (error) {
        await rm(finalPath, { force: true });
        throw error;
      }
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) return sendApiError(reply, 413, "AVATAR_TOO_LARGE", "头像不能超过 2 MB");
      if (isDomainCode(error, "VERSION_CONFLICT")) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
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

function detectImageType(content: Buffer): AvatarMediaType | undefined {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function isDomainCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
