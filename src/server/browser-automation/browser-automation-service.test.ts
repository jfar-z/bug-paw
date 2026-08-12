import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BROWSER_AUTOMATION_CONFIG } from "../../shared/browser-automation-contracts";
import { BrowserAutomationService } from "./browser-automation-service";

/** 服务端在每次原子操作前重新执行权限与 Origin 策略。 */
describe("浏览器策略编排服务", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("阻塞等待资源并创建一次 Run Context", async () => {
    const fixture = await createFixture();
    const onQueueUpdate = vi.fn();
    fixture.pool.acquire.mockImplementation(async (...args: unknown[]) => {
      const { onQueueUpdate: publish } = args[0] as { onQueueUpdate?: (update: { position: number; queued: number }) => void };
      publish?.({ position: 2, queued: 3 });
      return lease();
    });
    await fixture.service.execute({ sessionId: "session-a" }, openUrl(), new AbortController().signal, onQueueUpdate);
    expect(onQueueUpdate).toHaveBeenCalledWith({ position: 2, queued: 3 });
    expect(fixture.worker.createContext).toHaveBeenCalledOnce();
    await fixture.service.execute({ sessionId: "session-a" }, { type: "snapshot", maxCharacters: 2_000 }, new AbortController().signal);
    expect(fixture.worker.createContext).toHaveBeenCalledOnce();
  });

  it("公开游览仅允许 HTTPS 和配置的域名", async () => {
    const fixture = await createFixture({
      publicBrowsing: { ...DEFAULT_BROWSER_AUTOMATION_CONFIG.publicBrowsing, allowedDomains: ["example.com"] },
    });
    await expect(fixture.service.execute(context(), { type: "open", target: { kind: "url", url: "http://example.com" }, newPage: false }, signal()))
      .rejects.toMatchObject({ code: "BROWSER_PRIVATE_NETWORK_BLOCKED" });
    await expect(fixture.service.execute(context(), { type: "open", target: { kind: "url", url: "https://other.example" }, newPage: false }, signal()))
      .rejects.toMatchObject({ code: "BROWSER_PRIVATE_NETWORK_BLOCKED" });
  });

  it("文本输入必须是精确受信任 Origin 且开关已启用", async () => {
    const fixture = await createFixture();
    await fixture.service.execute(context(), openUrl(), signal());
    await expect(fixture.service.execute(context(), { type: "input", ref: "g1-e1", text: "hello" }, signal()))
      .rejects.toMatchObject({
        code: "BROWSER_ORIGIN_NOT_TRUSTED",
        permission: { settingsPath: "/settings/capabilities/browser", requiredSetting: "trustedOrigins" },
      });
  });

  it("本地 HTML 转换为内部预览且拒绝越界路径", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "browser-service-"));
    roots.push(cwd);
    await writeFile(join(cwd, "index.html"), "<!doctype html>", "utf8");
    const fixture = await createFixture();
    await fixture.service.open({ sessionId: "session-a" }, { path: "index.html", newPage: false }, signal());
    expect(fixture.preview.authorize).toHaveBeenCalledWith({ cwd, runId: "run-a", entryPath: "index.html" });
    expect(fixture.worker.createContext).toHaveBeenCalledWith(expect.objectContaining({
      egress: expect.objectContaining({ trustedOrigins: ["http://preview.internal"] }),
    }), expect.any(AbortSignal));
    await expect(fixture.service.open({ sessionId: "session-a" }, { path: "../outside.html", newPage: false }, signal()))
      .rejects.toMatchObject({ code: "BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE" });
  });

  it("浏览器权限按精确 Origin 分组后传给 Worker", async () => {
    const trustedOrigins = [
      { origin: "https://editor.example", allowTextInput: false, allowFormSubmit: false, allowFileUpload: false, grantedPermissions: ["clipboard-read" as const] },
      { origin: "https://preview.example", allowTextInput: false, allowFormSubmit: false, allowFileUpload: false, grantedPermissions: ["clipboard-write" as const] },
    ];
    const fixture = await createFixture({
      localPreview: { ...DEFAULT_BROWSER_AUTOMATION_CONFIG.localPreview, grantedPermissions: ["clipboard-write"] },
      trustedOrigins,
    });

    await fixture.service.execute(context(), openUrl(), signal());

    expect(fixture.worker.createContext).toHaveBeenCalledWith(expect.objectContaining({
      permissionGrants: [
        { origin: "http://preview.internal", permissions: ["clipboard-write"] },
        { origin: "https://editor.example", permissions: ["clipboard-read"] },
        { origin: "https://preview.example", permissions: ["clipboard-write"] },
      ],
    }), expect.any(AbortSignal));
  });

  it("上传只读取工作区文件并把 Worker 临时句柄交给命令", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "browser-service-"));
    roots.push(cwd);
    await writeFile(join(cwd, "fixture.txt"), "upload-content", "utf8");
    const trusted = [{ origin: "https://example.com", allowTextInput: false, allowFormSubmit: false, allowFileUpload: true, grantedPermissions: [] }];
    const fixture = await createFixture({ trustedOrigins: trusted });
    await fixture.service.execute(context(), openUrl(), signal());
    await fixture.service.upload(context(), { ref: "g1-e1", paths: ["fixture.txt"] }, signal());
    expect(fixture.worker.uploadFile).toHaveBeenCalledWith("lease-a", "fixture.txt", "text/plain", expect.any(Buffer), expect.any(Number), expect.any(AbortSignal));
    expect(fixture.worker.execute).toHaveBeenLastCalledWith("lease-a", expect.objectContaining({ type: "upload", files: [expect.objectContaining({ handle: "upload-a" })] }), expect.any(AbortSignal));
  });

  it("截图通过一次性句柄读取并由主服务保存相对路径", async () => {
    const fixture = await createFixture();
    fixture.worker.execute.mockResolvedValueOnce({ artifact: { handle: "artifact-a", mediaType: "image/png", size: 3 } });
    fixture.worker.readArtifact.mockResolvedValueOnce(Buffer.from("png"));
    const result = await fixture.service.execute(context(), { type: "screenshot", mode: "viewport", format: "png" }, signal());
    expect(fixture.worker.readArtifact).toHaveBeenCalledWith("lease-a", "artifact-a", expect.any(Number), expect.any(AbortSignal));
    expect(fixture.artifacts.saveScreenshot).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-a", format: "png", content: Buffer.from("png") }));
    expect(result).toMatchObject({ path: "browser-artifacts/capture.png" });
  });

  async function createFixture(overrides: Partial<typeof DEFAULT_BROWSER_AUTOMATION_CONFIG> = {}) {
    const cwd = roots.at(-1) ?? await mkdtemp(join(tmpdir(), "browser-service-"));
    if (!roots.includes(cwd)) roots.push(cwd);
    const config = { ...DEFAULT_BROWSER_AUTOMATION_CONFIG, ...overrides, enabled: true };
    const worker = {
      createContext: vi.fn(async () => ({ contextId: "lease-a" })),
      execute: vi.fn(async (_leaseId: string, command: { type: string }): Promise<unknown> => command.type === "open"
        ? { pageId: "page-1", url: "https://example.com/", title: "Example" }
        : { title: "Example", url: "https://example.com/" }),
      closeContext: vi.fn(async () => undefined),
      readArtifact: vi.fn(),
      uploadFile: vi.fn(async (_leaseId: string, name: string, mediaType: string) => ({ handle: "upload-a", name, mediaType })),
    };
    const pool = { acquire: vi.fn(async () => lease()) };
    const preview = { origin: "http://preview.internal", authorize: vi.fn(async () => ({ url: "http://preview.internal/token/index.html" })) };
    const artifacts = {
      saveScreenshot: vi.fn(async () => ({ path: "browser-artifacts/capture.png", mediaType: "image/png", size: 3, sha256: "a".repeat(64) })),
      saveDownload: vi.fn(),
    };
    const service = new BrowserAutomationService({
      deploymentAvailable: true,
      readConfig: vi.fn(async () => config),
      runRegistry: { requireCurrent: vi.fn(() => ({ agentId: "agent-a", sessionId: "session-a", runId: "run-a", cwd })) },
      pool,
      worker,
      preview,
      artifacts,
    } as never);
    return { service, worker, pool, preview, artifacts };
  }
});

function context() { return { sessionId: "session-a" }; }
function signal() { return new AbortController().signal; }
function openUrl() { return { type: "open", target: { kind: "url", url: "https://example.com" }, newPage: false } as const; }
function lease() { return { id: "lease-a", agentId: "agent-a", runId: "run-a", acquiredAt: Date.now(), heartbeat: vi.fn(), release: vi.fn(async () => undefined) }; }
