import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserPreviewService } from "./browser-preview-service";

/** 本地预览只能读取当前 Agent 工作区内的静态资源。 */
describe("浏览器静态预览服务", () => {
  const roots: string[] = [];

  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("授权 HTML 并读取工作区内的相对静态资源", async () => {
    const root = await workspace();
    await mkdir(join(root, "site"));
    await writeFile(join(root, "site", "index.html"), "<!doctype html><link rel=stylesheet href=app.css>", "utf8");
    await writeFile(join(root, "site", "app.css"), "body{color:red}", "utf8");
    const service = new BrowserPreviewService({ internalOrigin: "http://bug-paw-web:7080", token: () => "preview-token" });

    const grant = await service.authorize({ cwd: root, runId: "run-a", entryPath: "site/index.html" });
    expect(grant.url).toBe("http://bug-paw-web:7080/internal/browser-preview/preview-token/site/index.html");
    await expect(service.read("preview-token", "site/app.css")).resolves.toMatchObject({
      mediaType: "text/css",
      content: Buffer.from("body{color:red}"),
    });
  });

  it.each(["../outside.html", "/tmp/outside.html", "site/readme.txt"])("拒绝非法 HTML 入口：%s", async (entryPath) => {
    const root = await workspace();
    await mkdir(join(root, "site"));
    await writeFile(join(root, "site", "readme.txt"), "text", "utf8");
    const service = new BrowserPreviewService({ internalOrigin: "http://bug-paw-web:7080" });

    await expect(service.authorize({ cwd: root, runId: "run-a", entryPath })).rejects.toMatchObject({
      code: "BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE",
    });
  });

  it("拒绝越界符号链接、目录读取，并在 Run 结束后撤销授权", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "outside.html"), "secret", "utf8");
    await symlink(join(outside, "outside.html"), join(root, "linked.html"));
    const service = new BrowserPreviewService({ internalOrigin: "http://bug-paw-web:7080", token: () => "preview-token" });

    await expect(service.authorize({ cwd: root, runId: "run-a", entryPath: "linked.html" })).rejects.toMatchObject({
      code: "BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE",
    });
    await writeFile(join(root, "index.html"), "ok", "utf8");
    await service.authorize({ cwd: root, runId: "run-a", entryPath: "index.html" });
    await expect(service.read("preview-token", ".")).rejects.toMatchObject({ code: "BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE" });
    expect(service.revokeRun("run-a")).toBe(1);
    await expect(service.read("preview-token", "index.html")).rejects.toMatchObject({ code: "BROWSER_CONTEXT_EXPIRED" });
  });

  async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "browser-preview-"));
    roots.push(root);
    return root;
  }
});
