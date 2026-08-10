// @vitest-environment node

import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataPaths } from "../paths";
import { createKnowledgeBaseService } from "../knowledge-base/knowledge-base-service";
import { createKnowledgeRepository } from "../knowledge-base/knowledge-repository";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { createAgentRepository } from "../agents/agent-repository";
import { createIdentityRepository } from "../identity/identity-repository";
import { createAuthService, registerAuthRoutes } from "./auth";
import { registerKnowledgeBaseRoutes } from "./knowledge-bases";
import { registerSetupRoutes } from "./setup";

const roots: string[] = [];
const apps: FastifyInstance[] = [];

describe("知识库管理路由", () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("管理知识库、TXT 资料与关键词检索", async () => {
    const { app, cookieHeader } = await createApp();
    expect((await app.inject({ method: "GET", url: "/api/knowledge-bases" })).statusCode).toBe(401);
    const created = await app.inject({ method: "POST", url: "/api/knowledge-bases", headers: { cookie: cookieHeader }, payload: { name: "产品资料", agentIds: ["agent-a"] } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ agentIds: ["agent-a"], documents: [] });
    const baseId = created.json().id as string;
    const uploaded = await app.inject({ method: "POST", url: `/api/knowledge-bases/${baseId}/documents`, headers: multipartHeaders(cookieHeader, "knowledge-text"), payload: fileMultipart("knowledge-text", "产品.txt", "text/plain", Buffer.from("产品支持关键词检索", "utf8")) });
    expect(uploaded.statusCode).toBe(201);
    const documentId = uploaded.json().documents[0].id as string;
    expect((await app.inject({ method: "POST", url: `/api/knowledge-bases/${baseId}/search`, headers: { cookie: cookieHeader }, payload: { query: "关键词" } })).json()).toMatchObject({ results: [expect.objectContaining({ documentId })] });
    expect((await app.inject({ method: "GET", url: `/api/knowledge-bases/${baseId}/documents/${documentId}`, headers: { cookie: cookieHeader } })).json()).toMatchObject({ text: "产品支持关键词检索" });
    expect((await app.inject({ method: "GET", url: `/api/knowledge-bases/${baseId}/documents/${documentId}/chunks`, headers: { cookie: cookieHeader } })).json()).toMatchObject({
      chunks: [{ chunkId: `${documentId}:0`, documentId, index: 0, text: "产品支持关键词检索", page: 1 }],
    });
  });

  it("拒绝不支持的上传类型", async () => {
    const { app, cookieHeader } = await createApp();
    const created = await app.inject({ method: "POST", url: "/api/knowledge-bases", headers: { cookie: cookieHeader }, payload: { name: "产品资料" } });
    const response = await app.inject({ method: "POST", url: `/api/knowledge-bases/${created.json().id as string}/documents`, headers: multipartHeaders(cookieHeader, "knowledge-binary"), payload: fileMultipart("knowledge-binary", "a.exe", "application/octet-stream", Buffer.from("binary")) });
    expect(response.statusCode).toBe(415);
  });

  it("接受 Markdown 上传并可删除整个知识库", async () => {
    const { app, cookieHeader } = await createApp();
    const created = await app.inject({ method: "POST", url: "/api/knowledge-bases", headers: { cookie: cookieHeader }, payload: { name: "Markdown" } });
    const baseId = created.json().id as string;
    const uploaded = await app.inject({ method: "POST", url: `/api/knowledge-bases/${baseId}/documents`, headers: multipartHeaders(cookieHeader, "knowledge-markdown"), payload: fileMultipart("knowledge-markdown", "说明.md", "text/markdown", Buffer.from("# Markdown 资料", "utf8")) });
    expect(uploaded.statusCode).toBe(201);
    expect((await app.inject({ method: "DELETE", url: `/api/knowledge-bases/${baseId}`, headers: { cookie: cookieHeader } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/knowledge-bases/${baseId}`, headers: { cookie: cookieHeader } })).statusCode).toBe(404);
  });

  it("仅向已认证管理端返回资料原文件", async () => {
    const { app, cookieHeader } = await createApp();
    const created = await app.inject({ method: "POST", url: "/api/knowledge-bases", headers: { cookie: cookieHeader }, payload: { name: "原文件" } });
    const baseId = created.json().id as string;
    const uploaded = await app.inject({ method: "POST", url: `/api/knowledge-bases/${baseId}/documents`, headers: multipartHeaders(cookieHeader, "knowledge-source"), payload: fileMultipart("knowledge-source", "说明.md", "text/markdown", Buffer.from("# Markdown 资料", "utf8")) });
    const documentId = uploaded.json().documents[0].id as string;

    const source = await app.inject({ method: "GET", url: `/api/knowledge-bases/${baseId}/documents/${documentId}/source`, headers: { cookie: cookieHeader } });
    expect(source.statusCode).toBe(200);
    expect(source.headers["content-type"]).toContain("text/markdown");
    expect(source.body).toBe("# Markdown 资料");
    expect((await app.inject({ method: "GET", url: `/api/knowledge-bases/${baseId}/documents/${documentId}/source` })).statusCode).toBe(401);
  });
});

/** 创建带认证会话的真实路由测试应用。 */
async function createApp() {
  const root = await mkdtemp(join(tmpdir(), "pi-knowledge-routes-"));
  roots.push(root);
  const paths = await createDataPaths(root);
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(multipart);
  const database = openDatabase(paths.databaseFile);
  runMigrations(database);
  app.addHook("onClose", async () => database.close());
  const identities = createIdentityRepository(database);
  const authService = createAuthService(paths, { identityRepository: identities });
  await createAgentRepository(database).insert({
    version: 1, id: "agent-a", name: "Agent A", avatar: { kind: "initial", value: "A" }, description: "", status: "active",
    cwd: "/workspace/agent-a", allowedTools: [], createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
  });
  registerSetupRoutes(app, { paths, identityRepository: identities });
  registerAuthRoutes(app, { authService, paths });
  registerKnowledgeBaseRoutes(app, {
    authService,
    service: createKnowledgeBaseService({ paths, store: createKnowledgeRepository(database), agentExists: async (agentId) => agentId === "agent-a" }),
  });
  await app.ready();
  await app.inject({ method: "POST", url: "/api/setup", payload: { password: "correct horse battery", confirmPassword: "correct horse battery", provider: { type: "openai", apiKey: "test-key", defaultModel: "test" } } });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "correct horse battery", remember: false } });
  return { app, cookieHeader: String(login.headers["set-cookie"]).split(";", 1)[0] };
}

/** 构建包含认证 Cookie 的 multipart 请求头。 */
function multipartHeaders(cookieHeader: string, boundary: string) {
  return { cookie: cookieHeader, "content-type": `multipart/form-data; boundary=${boundary}` };
}

/** 构建单文件 multipart 请求体。 */
function fileMultipart(boundary: string, filename: string, mediaType: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`, "utf8"),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
}
