// @vitest-environment node

import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { AvatarCropArea } from "../../src/shared/avatar-contracts";
import { createAuthService } from "../../src/server/routes/auth";
import { registerAuthRoutes } from "../../src/server/routes/auth";
import { registerSetupRoutes } from "../../src/server/routes/setup";
import { registerStatusRoutes } from "../../src/server/routes/status";
import { createDataPaths, type DataPaths } from "../../src/server/paths";
import { readJson } from "../../src/server/storage";
import { openDatabase } from "../../src/server/database/database";
import { runMigrations } from "../../src/server/database/migrator";
import { createIdentityRepository } from "../../src/server/identity/identity-repository";

const apps: FastifyInstance[] = [];
const temporaryRoots: string[] = [];
const fixedNow = new Date("2026-08-05T08:00:00.000Z");

interface TestContext {
  app: FastifyInstance;
  paths: DataPaths;
}

async function createTestContext(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-routes-"));
  temporaryRoots.push(root);
  const paths = await createDataPaths(root);
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  await app.register(multipart);

  const authService = createAuthService(paths, { now: () => fixedNow });
  registerStatusRoutes(app, { paths, authService });
  registerSetupRoutes(app, { paths, now: () => fixedNow });
  registerAuthRoutes(app, { authService, paths });
  await app.ready();
  return { app, paths };
}

const validSetupBody = {
  password: "local-password-123",
  confirmPassword: "local-password-123",
  provider: {
    type: "openai-compatible",
    apiKey: "test-api-key-not-secret",
    baseUrl: "https://llm.example.test/v1",
    defaultModel: "example-model",
  },
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("首启与认证路由", () => {
  it("未初始化时返回公开状态，并完成一次性初始化", async () => {
    const { app, paths } = await createTestContext();

    const initialStatus = await app.inject({ method: "GET", url: "/api/status" });
    expect(initialStatus.statusCode).toBe(200);
    expect(initialStatus.json()).toEqual({ initialized: false, authenticated: false });

    const setup = await app.inject({ method: "POST", url: "/api/setup", payload: validSetupBody });
    expect(setup.statusCode).toBe(201);
    expect(setup.json()).toEqual({ initialized: true });
    expect(setup.body).not.toContain("test-api-key-not-secret");
    expect(setup.body).not.toContain("local-password-123");

    await expect(readJson(join(paths.appDir, "config.json"))).resolves.toBeUndefined();
    const database = openDatabase(paths.databaseFile);
    runMigrations(database);
    const owner = await createIdentityRepository(database).getUser("owner");
    expect(owner).toMatchObject({ id: "owner", password: { algorithm: "scrypt" }, revision: "1" });
    expect(owner?.password.hash).not.toContain("local-password-123");
    database.close();
    expect(await readJson(join(paths.piDir, "auth.json"))).toEqual({
      "openai-compatible": { type: "api_key", key: "test-api-key-not-secret" },
    });
    expect(await readJson(join(paths.piDir, "settings.json"))).toMatchObject({
      defaultProvider: "openai-compatible",
      defaultModel: "example-model",
    });
    await expect(readJson(join(paths.agentsDir, "default", "profile.json"))).resolves.toBeUndefined();

    const duplicate = await app.inject({ method: "POST", url: "/api/setup", payload: validSetupBody });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "ALREADY_INITIALIZED" } });
  });

  it("拒绝不一致的初始化密码且不创建配置", async () => {
    const { app, paths } = await createTestContext();
    const response = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { ...validSetupBody, confirmPassword: "different-password" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_SETUP" } });
    await expect(readJson(join(paths.appDir, "config.json"))).resolves.toBeUndefined();
  });

  it("仅使用密码登录，并按保持登录选项设置 Cookie", async () => {
    const { app } = await createTestContext();
    await app.inject({ method: "POST", url: "/api/setup", payload: validSetupBody });

    const failed = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "wrong-password", remember: true },
    });
    expect(failed.statusCode).toBe(401);
    expect(failed.json()).toMatchObject({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "访问密码错误",
        requestId: expect.any(String),
      },
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "local-password-123", remember: true },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ authenticated: true });
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=");
    const cookieHeader = setCookie.split(";", 1)[0];

    const sessionOnly = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "local-password-123", remember: false },
    });
    expect(String(sessionOnly.headers["set-cookie"])).not.toContain("Max-Age=");

    const legacyShape = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "local-password-123", remember: true },
    });
    expect(legacyShape.statusCode).toBe(400);
    expect(legacyShape.json()).toMatchObject({ error: { code: "INVALID_LOGIN_REQUEST" } });

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookieHeader } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ authenticated: true });

    const logout = await app.inject({ method: "POST", url: "/api/logout", headers: { cookie: cookieHeader } });
    expect(logout.statusCode).toBe(204);

    const meAfterLogout = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookieHeader } });
    expect(meAfterLogout.statusCode).toBe(401);
  });

  it("保存显示名和图片头像，且个人资料响应不暴露登录凭证", async () => {
    const { app } = await createTestContext();
    await app.inject({ method: "POST", url: "/api/setup", payload: validSetupBody });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "local-password-123", remember: true } });
    const cookieHeader = String(login.headers["set-cookie"]).split(";", 1)[0];
    const profile = await app.inject({ method: "GET", url: "/api/profile", headers: { cookie: cookieHeader } });

    const updated = await app.inject({
      method: "PATCH", url: "/api/profile", headers: { cookie: cookieHeader },
      payload: { revision: profile.json().revision, displayName: "小嘉" },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ profile: { displayName: "小嘉" } });
    expect(updated.body).not.toContain("local-password-123");
    expect(updated.body).not.toContain("password-hash");

    const source = await sharp(randomBytes(1_100 * 1_100 * 4), {
      raw: { width: 1_100, height: 1_100, channels: 4 },
    }).png().toBuffer();
    expect(source.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    const boundary = "profile-avatar";
    const avatar = await app.inject({
      method: "POST",
      url: `/api/profile/avatar?revision=${updated.json().revision as string}`,
      headers: { cookie: cookieHeader, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: avatarMultipart(boundary, source, { x: 10, y: 10, width: 80, height: 80 }),
    });

    expect(avatar.statusCode).toBe(200);
    expect(avatar.json().profile.avatar).toMatchObject({ kind: "image", mediaType: "image/webp" });
    const image = await app.inject({ method: "GET", url: "/api/profile/avatar", headers: { cookie: cookieHeader } });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/webp");
    expect(image.rawPayload.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    await expect(sharp(image.rawPayload).metadata()).resolves.toMatchObject({ format: "webp", width: 512, height: 512 });
  });
});

function avatarMultipart(boundary: string, content: Buffer, crop: AvatarCropArea): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`, "utf8"),
    content,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="crop"\r\n\r\n`
      + `${JSON.stringify(crop)}\r\n--${boundary}--\r\n`,
      "utf8",
    ),
  ]);
}
