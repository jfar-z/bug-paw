// @vitest-environment node

import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agents/agent-store";
import { createDataFileService } from "../data-files";
import { createDataPaths } from "../paths";
import type { AuthService } from "./auth";
import { registerDataFileRoutes } from "./data-files";

describe("Markdown 文件链接路由", () => {
  const roots: string[] = [];

  async function fixture(authenticated = true) {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-data-files-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const agents = new AgentStore(paths);
    const agent = await agents.createDefault();
    const authService = {
      isAuthenticated: vi.fn(async () => authenticated),
    } as unknown as AuthService;
    const app = Fastify();
    await app.register(cookie);
    registerDataFileRoutes(app, { authService, files: createDataFileService(paths, agents) });
    return { app, paths, cwd: agent.profile.cwd };
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("未登录时拒绝读取文件", async () => {
    const { app } = await fixture(false);
    const response = await app.inject({ method: "HEAD", url: "/api/agents/default/data-files?path=report.txt" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("相对路径按 Agent cwd 解析并通过文件头返回真实 MIME", async () => {
    const { app, cwd } = await fixture();
    await mkdir(join(cwd, "outputs"), { recursive: true });
    await writeFile(join(cwd, "outputs", "fake.txt"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const response = await app.inject({ method: "HEAD", url: "/api/agents/default/data-files?path=outputs/fake.txt" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(decodeURIComponent(String(response.headers["x-bugpaw-file-path"]))).toMatch(/^\/data\/workspace\/agents\/default\/outputs\/fake\.txt$/);
    expect(response.body).toBe("");
    await app.close();
  });

  it("支持 /data 绝对路径、内部符号链接和 Range 请求", async () => {
    const { app, paths } = await fixture();
    const directory = join(paths.rootDir, "shared");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "report.txt"), "abcdef", "utf8");
    await symlink(join(directory, "report.txt"), join(directory, "inside-link.txt"));

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/default/data-files?path=/data/shared/inside-link.txt",
      headers: { range: "bytes=1-3" },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 1-3/6");
    expect(response.body).toBe("bcd");
    await app.close();
  });

  it("支持 file URL 并从内容识别隔离预览的 SVG", async () => {
    const { app, paths } = await fixture();
    const directory = join(paths.rootDir, "shared files");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "diagram.txt"), "<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "utf8");

    const response = await app.inject({ method: "HEAD", url: "/api/agents/default/data-files?path=file%3A%2F%2F%2Fdata%2Fshared%2520files%2Fdiagram.txt" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/svg+xml");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    await app.close();
  });

  it("拒绝数据目录外路径、越界符号链接和目录", async () => {
    const { app, paths } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "bugpaw-data-files-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(paths.rootDir, "outside-link.txt"));

    const responses = await Promise.all([
      app.inject({ method: "HEAD", url: "/api/agents/default/data-files?path=/etc/passwd" }),
      app.inject({ method: "HEAD", url: "/api/agents/default/data-files?path=/data/outside-link.txt" }),
      app.inject({ method: "HEAD", url: "/api/agents/default/data-files?path=/data/workspace" }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400]);
    await app.close();
  });

  it("文本预览限制大小并拒绝带空字节的伪文本", async () => {
    const { app, cwd } = await fixture();
    await writeFile(join(cwd, "large.txt"), "a".repeat(512 * 1024 + 8), "utf8");
    await writeFile(join(cwd, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(cwd, "invalid.txt"), Buffer.from([0xc3, 0x28]));

    const preview = await app.inject({ method: "GET", url: "/api/agents/default/data-files/text?path=large.txt" });
    const rejected = await app.inject({ method: "GET", url: "/api/agents/default/data-files/text?path=binary.txt" });
    const invalid = await app.inject({ method: "GET", url: "/api/agents/default/data-files/text?path=invalid.txt" });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ truncated: true });
    expect(preview.json().content).toHaveLength(512 * 1024);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ error: { code: "TEXT_PREVIEW_UNAVAILABLE" } });
    expect(invalid.statusCode).toBe(422);
    await app.close();
  });
});
