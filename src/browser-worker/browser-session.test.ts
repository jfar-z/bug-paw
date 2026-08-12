import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";

import { BrowserSession } from "./browser-session";

const runBrowserTests = process.env.RUN_BROWSER_TESTS === "true";

/** 真实 Chromium 验证稳定 ref、滚动、截图和敏感输入拒绝。 */
describe.skipIf(!runBrowserTests)("Playwright 浏览器 Session", () => {
  let browser: Browser;
  let context: BrowserContext;
  let session: BrowserSession;
  let baseUrl: string;
  const server = createServer((_request, response) => {
    if (_request.url === "/download") {
      response.setHeader("content-type", "text/plain");
      response.setHeader("content-disposition", "attachment; filename=fixture.txt");
      response.end("download-content");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><body style="height:2400px">
      <a href="#detail">查看详情</a>
      <input aria-label="搜索文档" type="search">
      <input aria-label="账号密码" type="password">
      <button type="button">展开内容</button>
    </body></html>`);
  });

  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: true });
    session = new BrowserSession(context, { maxPages: 2 });
  });

  afterAll(async () => {
    await session?.close();
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("打开页面、生成引用、滚动和截图", async () => {
    await session.execute({ type: "open", target: { kind: "url", url: baseUrl }, newPage: false });
    const snapshot = await session.execute({ type: "snapshot", maxCharacters: 10_000 });
    expect(snapshot).toMatchObject({ title: "", url: `${baseUrl}/` });
    const search = snapshot.elements.find((element) => element.name === "搜索文档")!;
    await session.execute({ type: "input", ref: search.ref, text: "Playwright" });
    await session.execute({ type: "scroll", direction: "down", amount: "medium" });
    const screenshot = await session.execute({ type: "screenshot", mode: "viewport", format: "png" });
    expect(screenshot.artifact.content.length).toBeGreaterThan(100);
  });

  it("限制页面数量并读取下载", async () => {
    await session.execute({ type: "open", target: { kind: "url", url: baseUrl }, newPage: false });
    await session.execute({ type: "open", target: { kind: "url", url: baseUrl }, newPage: true });
    await expect(session.execute({ type: "open", target: { kind: "url", url: baseUrl }, newPage: true }))
      .rejects.toMatchObject({ code: "BROWSER_ARTIFACT_LIMIT_REACHED" });
    const result = await session.execute({ type: "download", source: { kind: "url", url: `${baseUrl}/download` } });
    expect(result.artifact).toMatchObject({ suggestedName: "fixture.txt" });
    expect(result.artifact.content.toString("utf8")).toBe("download-content");
  });

  it("拒绝敏感输入并使旧 generation 引用失效", async () => {
    const snapshot = await session.execute({ type: "snapshot", maxCharacters: 10_000 });
    const password = snapshot.elements.find((element) => element.name === "账号密码")!;
    await expect(session.execute({ type: "input", ref: password.ref, text: "secret" })).rejects.toMatchObject({
      code: "BROWSER_HARD_SAFETY_BLOCKED",
    });
    await session.execute({ type: "snapshot", maxCharacters: 10_000 });
    await expect(session.execute({ type: "click", ref: password.ref })).rejects.toMatchObject({
      code: "BROWSER_ELEMENT_REFERENCE_STALE",
    });
  });
});
