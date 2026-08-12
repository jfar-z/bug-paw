import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BROWSER_AUTOMATION_CONFIG } from "../../shared/browser-automation-contracts";
import { BrowserArtifactService } from "./browser-artifact-service";

/** 浏览器产物必须在当前工作区原子落盘并执行配额。 */
describe("浏览器产物服务", () => {
  const roots: string[] = [];

  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("保存下载并返回安全相对路径、大小和 SHA-256", async () => {
    const cwd = await workspace();
    const service = createService();

    const artifact = await service.saveDownload({
      cwd,
      runId: "run-a",
      originalName: "../报告.pdf",
      mediaType: "application/pdf",
      sourceUrl: "https://example.com/report.pdf",
      stream: Readable.from([Buffer.from("document")]),
    });

    expect(artifact.path).toMatch(/^browser-artifacts\/2026-08-12\/task-a\/downloads\/报告\.pdf$/u);
    expect(artifact.size).toBe(8);
    expect(artifact.sha256).toHaveLength(64);
    expect(await readFile(join(cwd, artifact.path), "utf8")).toBe("document");
    const manifest = JSON.parse(await readFile(join(cwd, "browser-artifacts/2026-08-12/task-a/manifest.json"), "utf8"));
    expect(JSON.stringify(manifest)).not.toContain("document");
  });

  it("处理重名并拒绝不允许的 MIME 与超大下载", async () => {
    const cwd = await workspace();
    const service = createService({ maxDownloadBytes: 4 });
    const input = {
      cwd,
      runId: "run-a",
      originalName: "report.pdf",
      mediaType: "application/pdf",
      sourceUrl: "https://example.com/report.pdf",
      stream: Readable.from([Buffer.from("1234")]),
    };

    await service.saveDownload(input);
    const second = await service.saveDownload({ ...input, stream: Readable.from([Buffer.from("1234")]) });
    expect(second.path).toContain("report (1).pdf");
    await expect(service.saveDownload({ ...input, mediaType: "application/x-msdownload", stream: Readable.from([Buffer.from("x")]) }))
      .rejects.toMatchObject({ code: "BROWSER_DOWNLOAD_BLOCKED" });
    await expect(service.saveDownload({ ...input, stream: Readable.from([Buffer.from("12345")]) }))
      .rejects.toMatchObject({ code: "BROWSER_DOWNLOAD_TOO_LARGE" });
    expect((await readdir(join(cwd, "browser-artifacts/2026-08-12/task-a/downloads"))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("分别限制每 Run 的截图和下载数量", async () => {
    const cwd = await workspace();
    const service = createService({ maxDownloadsPerRun: 1, maxScreenshotsPerRun: 1 });
    await service.saveDownload(download(cwd));
    await expect(service.saveDownload(download(cwd))).rejects.toMatchObject({ code: "BROWSER_ARTIFACT_LIMIT_REACHED" });
    await service.saveScreenshot({ cwd, runId: "run-a", format: "png", content: Buffer.from("png") });
    await expect(service.saveScreenshot({ cwd, runId: "run-a", format: "png", content: Buffer.from("png") }))
      .rejects.toMatchObject({ code: "BROWSER_ARTIFACT_LIMIT_REACHED" });
  });

  function createService(overrides: Partial<typeof DEFAULT_BROWSER_AUTOMATION_CONFIG.artifacts> = {}) {
    return new BrowserArtifactService({ ...DEFAULT_BROWSER_AUTOMATION_CONFIG.artifacts, ...overrides }, {
      now: () => new Date("2026-08-12T08:00:00.000Z"),
      taskId: () => "task-a",
    });
  }

  function download(cwd: string) {
    return { cwd, runId: "run-a", originalName: "file.pdf", mediaType: "application/pdf", sourceUrl: "https://example.com/file.pdf", stream: Readable.from([Buffer.from("x")]) };
  }

  async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "browser-artifact-"));
    roots.push(root);
    return root;
  }
});
