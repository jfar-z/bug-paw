// @vitest-environment node
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createDataPaths } from "../../src/server/paths";
import { hashPassword } from "../../src/server/auth";
import { openDatabase } from "../../src/server/database/database";
import { runMigrations } from "../../src/server/database/migrator";
import { createIdentityRepository } from "../../src/server/identity/identity-repository";
import { createAuthService, registerAuthRoutes } from "../../src/server/routes/auth";
import { registerOriginProtection } from "../../src/server/routes/origin-protection";
import { registerApiErrorHandler } from "../../src/server/http/error-handler";
import { createTotpSecret, matchTotp, totpAt } from "../../src/server/identity/totp";

const cleanups: Array<() => Promise<void>> = [];
const password = "test-only-local-password";
const referenceSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** 只创建临时身份数据库，不读取生产身份或验证器。 */
async function context() {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-totp-"));
  const paths = await createDataPaths(root);
  const database = openDatabase(paths.databaseFile);
  runMigrations(database);
  let time = 1_800_000_000_000;
  const repository = createIdentityRepository(database);
  await repository.initializeUser({ id: "owner", password: await hashPassword(password), displayName: "测试管理员", now: new Date(time).toISOString() });
  const app = Fastify();
  await app.register(cookie);
  registerApiErrorHandler(app);
  registerOriginProtection(app);
  const auth = createAuthService(paths, { identityRepository: repository, now: () => new Date(time) });
  registerAuthRoutes(app, { authService: auth, paths });
  // 用真实 HTTP 长连接验证会话撤销，避免注入请求掩盖事件流生命周期。
  app.get("/api/sessions/test/events", async (request, reply) => {
    if (!(await auth.isAuthenticated(request))) return reply.code(401).send();
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write("data: ready\n\n");
  });
  await app.ready();
  cleanups.push(async () => { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  const post = (url: string, payload: unknown, cookies = "") => app.inject({ method: "POST", url: `/api/${url}`, payload, headers: { cookie: cookies } });
  const login = () => post("login", { password, remember: false });
  const cookieOf = (response: { cookies: Array<{ name: string; value: string }> }, name = "pi_agent_session") => {
    const item = response.cookies.find((item) => item.name === name);
    return item ? `${name}=${item.value}` : "";
  };
  async function setup(session: string) {
    const response = await post("security/totp/setup", { password }, session);
    expect(response.statusCode).toBe(200);
    return response.json() as { secret: string; qrCode: string; expiresAt: string };
  }
  async function enable() {
    const first = await login();
    const oldSession = cookieOf(first);
    const setupResult = await setup(oldSession);
    const response = await post("security/totp/confirm", { code: totpAt(setupResult.secret, time) }, oldSession);
    expect(response.statusCode).toBe(200);
    return { secret: setupResult.secret, session: cookieOf(response), oldSession, recoveryCodes: response.json().recoveryCodes as string[] };
  }
  return { app, auth, database, paths, repository, post, login, cookieOf, setup, enable, now: () => time, advance: (ms = 61_000) => { time += ms; } };
}

describe("RFC 6238 与动态验证码", () => {
  it("通过 RFC 附录 B 的 SHA-1 标准向量及 2038 年后的时间", () => {
    for (const [seconds, expected] of [[59,"94287082"],[1111111109,"07081804"],[1111111111,"14050471"],[1234567890,"89005924"],[2000000000,"69279037"],[20000000000,"65353130"]] as const) {
      expect(totpAt(referenceSecret, seconds * 1000, 8)).toBe(expected);
    }
    expect(totpAt(referenceSecret, 1111111109_000)).toBe("081804");
  });
  it("密钥随机、保留前导零，并限制时钟偏差与已用时间步", () => {
    expect(createTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(createTotpSecret()).not.toBe(createTotpSecret());
    expect(matchTotp(referenceSecret, "081804", 1111111109_000)).toBe(Math.floor(1111111109 / 30));
    const code = totpAt(referenceSecret, 59_000);
    expect(matchTotp(referenceSecret, code, 60_000)).toBe(1);
    expect(matchTotp(referenceSecret, code, 90_000)).toBeUndefined();
    expect(matchTotp(referenceSecret, code, 59_000, 1)).toBeUndefined();
    expect(matchTotp(referenceSecret, " 287082", 59_000)).toBeUndefined();
  });
});

describe("双因素绑定与登录", () => {
  it("验证失败保留事件流，启用成功立即断开旧会话事件流", async () => {
    const c = await context();
    const session = c.cookieOf(await c.login());
    const setup = await c.setup(session);
    const address = await c.app.listen({ host: "127.0.0.1", port: 0 });
    const stream = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(`${address}/api/sessions/test/events`, { headers: { cookie: session } }, resolve);
      request.on("error", reject);
    });
    stream.on("error", () => undefined);
    stream.resume();
    try {
      expect((await c.post("security/totp/confirm", { code: "------" }, session)).statusCode).toBe(400);
      expect(stream.destroyed).toBe(false);
      const closed = new Promise<void>((resolve) => stream.once("close", resolve));
      expect((await c.post("security/totp/confirm", { code: totpAt(setup.secret, c.now()) }, session)).statusCode).toBe(200);
      await closed;
      expect(stream.destroyed).toBe(true);
    } finally { stream.destroy(); }
  });

  it("首次确认前不启用；密钥加密且响应不可缓存，确认后撤销旧会话", async () => {
    const c = await context();
    const session = c.cookieOf(await c.login());
    const other = c.cookieOf(await c.login());
    const setup = await c.setup(session);
    expect(setup.qrCode).toMatch(/^data:image\/png;base64,/);
    expect(c.database.readOne<{ secret: string }>("SELECT secret FROM auth_challenges WHERE kind='setup'")!.secret).not.toContain(setup.secret);
    expect((await stat(join(c.paths.appDir, "totp-encryption.key"))).mode & 0o777).toBe(0o600);
    const before = await c.app.inject({ url: "/api/security/totp", headers: { cookie: session } });
    expect(before.headers["cache-control"]).toBe("no-store");
    expect(before.json()).toEqual({ enabled: false, enabledAt: null, recoveryCodesRemaining: 0 });
    const wrong = await c.post("security/totp/confirm", { code: "------" }, session);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: { code: "TOTP_INVALID_CODE", requestId: expect.any(String) } });
    expect(c.repository.security.state().secret).toBeNull();
    const confirmed = await c.post("security/totp/confirm", { code: totpAt(setup.secret, c.now()) }, session);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().recoveryCodes).toHaveLength(8);
    expect(confirmed.body).not.toContain(setup.secret);
    expect(String(confirmed.headers["set-cookie"])).not.toContain("Max-Age");
    for (const old of [session, other]) expect((await c.app.inject({ url: "/api/me", headers: { cookie: old } })).statusCode).toBe(401);
    const status = await c.app.inject({ url: "/api/security/totp", headers: { cookie: c.cookieOf(confirmed) } });
    expect(status.json()).toMatchObject({ enabled: true, recoveryCodesRemaining: 8 });
    expect(status.body).not.toContain(setup.secret);
    expect((await readFile(c.paths.databaseFile)).includes(Buffer.from(setup.secret))).toBe(false);
  });

  it("密码正确只创建挑战；拒绝重放、跨挑战并发消费与重复挑战", async () => {
    const c = await context();
    const enabled = await c.enable();
    const first = await c.login();
    expect(first.json()).toMatchObject({ authenticated: false, requiresTwoFactor: true });
    expect(c.cookieOf(first)).toBe("");
    const challenge = c.cookieOf(first, "pi_agent_challenge");
    expect((await c.app.inject({ url: "/api/me", headers: { cookie: challenge } })).statusCode).toBe(401);
    expect((await c.post("login/totp", { code: totpAt(enabled.secret, c.now()) }, challenge)).statusCode).toBe(400);
    c.advance();
    const second = c.cookieOf(await c.login(), "pi_agent_challenge");
    const code = totpAt(enabled.secret, c.now());
    const results = await Promise.all([c.post("login/totp", { code }, challenge), c.post("login/totp", { code }, second)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect([results.find((r) => r.statusCode === 200)!.headers["set-cookie"]].flat().find((value) => value?.startsWith("pi_agent_session="))).not.toContain("Max-Age");
    const successfulChallenge = results[0].statusCode === 200 ? challenge : second;
    expect((await c.post("login/totp", { code }, successfulChallenge)).json().error.code).toBe("TOTP_CHALLENGE_EXPIRED");
  });

  it("绑定草稿绑定会话，取消、重新生成和超时不启用", async () => {
    const c = await context();
    const session = c.cookieOf(await c.login());
    const other = c.cookieOf(await c.login());
    const setup = await c.setup(session);
    expect((await c.post("security/totp/confirm", { code: totpAt(setup.secret, c.now()) }, other)).json().error.code).toBe("TOTP_CHALLENGE_EXPIRED");
    await c.app.inject({ method: "DELETE", url: "/api/security/totp/setup", headers: { cookie: session } });
    expect((await c.post("security/totp/confirm", { code: totpAt(setup.secret, c.now()) }, session)).json().error.code).toBe("TOTP_CHALLENGE_EXPIRED");
    c.advance();
    const replaced = await c.setup(session);
    await c.setup(session);
    expect((await c.post("security/totp/confirm", { code: totpAt(replaced.secret, c.now()) }, session)).statusCode).toBe(400);
    c.advance(301_000);
    expect((await c.post("security/totp/confirm", { code: "123456" }, session)).json().error.code).toBe("TOTP_CHALLENGE_EXPIRED");
    expect(c.repository.security.state().secret).toBeNull();
    expect((await c.login()).json()).toEqual({ authenticated: true });
  });

  it("数据库提交失败时回滚密钥、恢复码与会话撤销", async () => {
    const c = await context();
    const session = c.cookieOf(await c.login());
    const setup = await c.setup(session);
    c.database.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON totp_recovery_codes BEGIN SELECT RAISE(ABORT,'injected-write-error'); END");
    const response = await c.post("security/totp/confirm", { code: totpAt(setup.secret, c.now()) }, session);
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("SECURITY_STORAGE_FAILED");
    expect(response.body).not.toContain("injected-write-error");
    expect(c.repository.security.state().secret).toBeNull();
    expect(c.repository.security.recoveryCount()).toBe(0);
    expect((await c.app.inject({ url: "/api/me", headers: { cookie: session } })).statusCode).toBe(200);
    c.database.exec("DROP TRIGGER fail_recovery");
    expect((await c.post("security/totp/confirm", { code: totpAt(setup.secret, c.now()) }, session)).statusCode).toBe(200);
  });

  it("恢复码只消费一次，重启后仍然生效且只存摘要", async () => {
    const c = await context();
    const enabled = await c.enable();
    const code = enabled.recoveryCodes[0];
    const persisted = c.database.read<{ code_hash: string }>("SELECT code_hash FROM totp_recovery_codes");
    expect(persisted.every((r) => /^[a-f0-9]{64}$/.test(r.code_hash))).toBe(true);
    const restarted = createAuthService(c.paths, { identityRepository: c.repository, now: () => new Date(c.now()) });
    const login = await restarted.login(password, "test", false);
    expect(login.status).toBe("second_factor_required");
    if (login.status !== "second_factor_required") throw new Error("challenge missing");
    const result = restarted.twoFactor.completeLogin(login.challenge, code.toLowerCase(), true);
    expect(result.remember).toBe(false);
    expect(c.repository.security.recoveryCount()).toBe(7);
    const next = c.cookieOf(await c.login(), "pi_agent_challenge");
    expect((await c.post("login/totp", { code, recovery: true }, next)).json().error.code).toBe("TOTP_INVALID_CODE");
  });

  it("关闭和重新生成均需两项凭据，撤销旧挑战和恢复码", async () => {
    const c = await context();
    const enabled = await c.enable();
    const challenge = c.cookieOf(await c.login(), "pi_agent_challenge");
    const bad = await c.post("security/totp/disable", { password: "wrong", code: enabled.recoveryCodes[0], recovery: true }, enabled.session);
    expect(bad.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(c.repository.security.state().secret).not.toBeNull();
    c.advance();
    const replaced = await c.post("security/totp/recovery", { password, code: enabled.recoveryCodes[0], recovery: true }, enabled.session);
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().recoveryCodes).not.toEqual(enabled.recoveryCodes);
    expect((await c.post("login/totp", { code: enabled.recoveryCodes[1], recovery: true }, challenge)).json().error.code).toBe("TOTP_CHALLENGE_EXPIRED");
    const disabled = await c.post("security/totp/disable", { password, code: replaced.json().recoveryCodes[0], recovery: true }, c.cookieOf(replaced));
    expect(disabled.statusCode).toBe(200);
    expect(c.repository.security.state().secret).toBeNull();
    expect(c.repository.security.recoveryCount()).toBe(0);
    expect((await c.login()).json()).toEqual({ authenticated: true });
  });

  it("限流不随挑战刷新或服务重启清零；过期挑战不能登录", async () => {
    const c = await context(); await c.enable();
    const login = await c.login();
    const challenge = c.cookieOf(login, "pi_agent_challenge");
    for (let i = 0; i < 5; i++) expect((await c.post("login/totp", { code: "------" }, challenge)).statusCode).toBe(400);
    const fresh = c.cookieOf(await c.login(), "pi_agent_challenge");
    expect((await c.post("login/totp", { code: "123456" }, fresh)).statusCode).toBe(429);
    const reopened = createAuthService(c.paths, { identityRepository: c.repository, now: () => new Date(c.now()) });
    expect(() => reopened.twoFactor.completeLogin(undefined, "123456", false)).toThrow(/频繁/);
    c.advance(301_000);
    expect((await c.post("login/totp", { code: "123456" }, challenge)).statusCode).toBe(410);
  });

  it("未经认证及跨站请求不可管理，缺失加密文件时拒绝登录且不重建密钥", async () => {
    const c = await context();
    expect((await c.app.inject({ url: "/api/security/totp" })).statusCode).toBe(401);
    const enabled = await c.enable();
    const crossSite = await c.app.inject({ method: "POST", url: "/api/security/totp/disable", headers: { origin: "https://evil.invalid", cookie: enabled.session }, payload: { password, code: "123456" } });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.headers["cache-control"]).toBe("no-store");
    const challenge = c.cookieOf(await c.login(), "pi_agent_challenge");
    await unlink(join(c.paths.appDir, "totp-encryption.key"));
    c.advance();
    const result = await c.post("login/totp", { code: totpAt(enabled.secret, c.now()) }, challenge);
    expect(result.statusCode).toBe(500);
    expect(result.json().error.code).toBe("SECURITY_STORAGE_FAILED");
    await expect(stat(join(c.paths.appDir, "totp-encryption.key"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(c.repository.security.state().secret).not.toBeNull();
  });
});
