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
