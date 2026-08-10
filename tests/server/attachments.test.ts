// @vitest-environment node

import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_UPLOAD_LIMITS,
  createWorkspaceFileService,
  sanitizeAttachmentName,
} from "../../src/server/attachments";
import { createDataPaths, type DataPaths } from "../../src/server/paths";
import { AgentStore } from "../../src/server/agents/agent-store";
import { createAuthService, registerAuthRoutes } from "../../src/server/routes/auth";
import { registerAttachmentRoutes } from "../../src/server/routes/attachments";
import { registerSetupRoutes } from "../../src/server/routes/setup";

const apps: FastifyInstance[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent 工作目录文件", () => {
  it("使用固定限制并净化跨平台危险文件名", () => {
    expect(DEFAULT_UPLOAD_LIMITS).toEqual({ maxFiles: 5, maxFileSize: 100 * 1024 * 1024 });
    expect(sanitizeAttachmentName("../../..\\秘密 图片.png")).toBe("秘密 图片.png");
    expect(sanitizeAttachmentName("...\u0000")).toBe("attachment");
  });

  it("以相对路径保存文件并原子解决并发重名", async () => {
    const { paths, defaultCwd } = await createFixture();
    const service = createWorkspaceFileService(paths);

    const [first, second] = await Promise.all([
      service.saveUpload("default", "报告.pdf", "application/pdf", Readable.from("first")),
      service.saveUpload("default", "报告.pdf", "application/pdf", Readable.from("second")),
    ]);

    expect([first.path, second.path].sort()).toEqual(["attachments/报告 (1).pdf", "attachments/报告.pdf"]);
    expect(await readdir(join(defaultCwd, "attachments"))).toEqual(expect.arrayContaining(["报告.pdf", "报告 (1).pdf"]));
    await expect(readFile(first.absolutePath, "utf8")).resolves.toBe("first");
    await expect(readFile(second.absolutePath, "utf8")).resolves.toBe("second");
    await expect(readFile(join(paths.agentsDir, "default", "attachments.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("拒绝绝对路径、越界路径和指向 cwd 外部的符号链接", async () => {
    const { root, paths, defaultCwd } = await createFixture();
    const service = createWorkspaceFileService(paths);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(defaultCwd, "outside-link.txt"));

    await expect(service.resolve("default", "/etc/passwd")).rejects.toThrow("相对路径");
    await expect(service.resolve("default", "../outside.txt")).rejects.toThrow("工作目录");
    await expect(service.resolve("default", "bad\u0000name")).rejects.toThrow("NUL");
    await expect(service.resolve("default", "outside-link.txt")).resolves.toBeUndefined();
  });

  it("拒绝未登录请求和未知 Agent", async () => {
    const { app, cookieHeader } = await createApp();
    const unauthorized = await app.inject({ method: "GET", url: "/api/agents/default/files/missing.txt" });
    const unknownAgent = await app.inject({
      method: "GET",
      url: "/api/agents/other/files/missing.txt",
      headers: { cookie: cookieHeader },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unknownAgent.statusCode).toBe(404);
  });

  it("上传返回相对路径，并通过通用文件接口预览、Range 和下载", async () => {
    const { app, defaultCwd, cookieHeader } = await createApp();
    const upload = await app.inject({
      method: "POST",
      url: "/api/agents/default/attachments",
      headers: { cookie: cookieHeader, "content-type": "multipart/form-data; boundary=pi-test" },
      payload: multipartBody("pi-test", [{ name: "../../示例 图片.txt", type: "text/plain", content: "hello agent" }]),
    });

    expect(upload.statusCode).toBe(201);
    const file = upload.json().files[0];
    expect(file).toMatchObject({ path: "attachments/示例 图片.txt", name: "示例 图片.txt", mediaType: "text/plain", size: 11 });
    expect(file).not.toHaveProperty("absolutePath");
    await expect(readFile(join(defaultCwd, file.path), "utf8")).resolves.toBe("hello agent");

    const fileUrl = "/api/agents/default/files/attachments/%E7%A4%BA%E4%BE%8B%20%E5%9B%BE%E7%89%87.txt";
    const head = await app.inject({ method: "HEAD", url: fileUrl, headers: { cookie: cookieHeader } });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe("11");

    const partial = await app.inject({ method: "GET", url: fileUrl, headers: { cookie: cookieHeader, range: "bytes=6-10" } });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers["content-range"]).toBe("bytes 6-10/11");
    expect(partial.body).toBe("agent");

    const download = await app.inject({ method: "GET", url: `${fileUrl}?download=1`, headers: { cookie: cookieHeader } });
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["content-disposition"]).toContain("filename*=");
  });

  it("允许非默认 Agent 上传并读取自己工作目录中的附件", async () => {
    const { app, paths, cookieHeader } = await createApp();
    const agent = await new AgentStore(paths).create({ name: "lux" });
    const upload = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.profile.id}/attachments`,
      headers: { cookie: cookieHeader, "content-type": "multipart/form-data; boundary=pi-lux" },
      payload: multipartBody("pi-lux", [{ name: "lux-note.txt", type: "text/plain", content: "lux attachment" }]),
    });

    expect(upload.statusCode).toBe(201);
    const path = upload.json().files[0].path;
    expect(await readFile(join(agent.profile.cwd, path), "utf8")).toBe("lux attachment");
    const downloaded = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.profile.id}/files/${path}`,
      headers: { cookie: cookieHeader },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe("lux attachment");
  });

  it("允许读取 cwd 内由 Agent 生成的普通文件", async () => {
    const { app, defaultCwd, cookieHeader } = await createApp();
    await writeFile(join(defaultCwd, "result.json"), "{\"ok\":true}", "utf8");

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/default/files/result.json",
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toBe('{"ok":true}');
  });

  it("按可配置边界拒绝过大文件和过多文件", async () => {
    const { app, cookieHeader } = await createApp({ maxFiles: 2, maxFileSize: 8 });
    const oversized = await uploadFiles(app, cookieHeader, [{ name: "large.txt", type: "text/plain", content: "123456789" }]);
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ error: { code: "ATTACHMENT_TOO_LARGE" } });

    const tooMany = await uploadFiles(app, cookieHeader, [
      { name: "1.txt", type: "text/plain", content: "1" },
      { name: "2.txt", type: "text/plain", content: "2" },
      { name: "3.txt", type: "text/plain", content: "3" },
    ]);
    expect(tooMany.statusCode).toBe(413);
    expect(tooMany.json()).toMatchObject({ error: { code: "TOO_MANY_ATTACHMENTS" } });
  });
});

interface FileFixture {
  name: string;
  type: string;
  content: string;
}

async function createFixture(): Promise<{ root: string; paths: DataPaths; defaultCwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-files-"));
  roots.push(root);
  const paths = await createDataPaths(root);
  // 附件服务使用历史 default Agent，验证旧安装升级后的文件访问兼容性。
  const defaultAgent = await new AgentStore(paths).createDefault();
  return { root, paths, defaultCwd: defaultAgent.profile.cwd };
}

async function createApp(limits = DEFAULT_UPLOAD_LIMITS): Promise<{ app: FastifyInstance; paths: DataPaths; defaultCwd: string; cookieHeader: string }> {
  const { paths, defaultCwd } = await createFixture();
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  await app.register(multipart, { limits: { files: limits.maxFiles, fileSize: limits.maxFileSize } });
  const authService = createAuthService(paths);
  registerSetupRoutes(app, { paths });
  registerAuthRoutes(app, { authService });
  registerAttachmentRoutes(app, { authService, files: createWorkspaceFileService(paths), limits });
  await app.ready();
  const cookieHeader = await initializeAndLogin(app);
  // 首启不再自动创建 Agent；此夹具显式构造升级前已有的 default Agent。
  await new AgentStore(paths).createDefault();
  return { app, paths, defaultCwd, cookieHeader };
}

async function initializeAndLogin(app: FastifyInstance): Promise<string> {
  await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      password: "local-password-123",
      confirmPassword: "local-password-123",
      provider: { type: "test", apiKey: "test-key-not-secret", defaultModel: "model-1" },
    },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "local-password-123", remember: false },
  });
  return String(login.headers["set-cookie"]).split(";", 1)[0];
}

async function uploadFiles(app: FastifyInstance, cookieHeader: string, files: FileFixture[]) {
  return app.inject({
    method: "POST",
    url: "/api/agents/default/attachments",
    headers: { cookie: cookieHeader, "content-type": "multipart/form-data; boundary=pi-limit" },
    payload: multipartBody("pi-limit", files),
  });
}

function multipartBody(boundary: string, files: FileFixture[]): Buffer {
  const chunks = files.flatMap((file) => [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="files"; filename="${file.name}"\r\n`,
    `Content-Type: ${file.type}\r\n\r\n`,
    file.content,
    "\r\n",
  ]);
  return Buffer.from(`${chunks.join("")}--${boundary}--\r\n`, "utf8");
}
