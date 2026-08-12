import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("PWA 应用壳", () => {
  it("manifest 具备独立应用安装信息", async () => {
    const manifest = JSON.parse(await readFile("public/manifest.webmanifest", "utf8")) as Record<string, unknown>;

    expect(manifest.name).toBe("BugPaw Agent 工作台");
    expect(manifest.short_name).toBe("BugPaw");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.theme_color).toBe("#171c22");
    expect(manifest.background_color).toBe("#f7f6f2");
    expect(manifest.icons).toEqual(expect.arrayContaining([expect.objectContaining({
      src: "/brand/bugpaw/bugpaw-paw-icon-192.png",
      sizes: "192x192",
      type: "image/png",
    })]));
    expect(manifest.icons).toEqual(expect.arrayContaining([expect.objectContaining({
      src: "/brand/bugpaw/bugpaw-paw-icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    })]));
  });

  it("页面元信息使用 BugPaw 标题与独立猫爪 favicon", async () => {
    const source = await readFile("index.html", "utf8");

    expect(source).toContain("<title>BugPaw</title>");
    expect(source).toContain('content="私有部署的 BugPaw AI Agent 工作台"');
    expect(source).toContain('href="/brand/bugpaw/bugpaw-paw-favicon.png"');
    expect(source).not.toContain("/icons/icon.svg");
  });

  it("service worker 只缓存同源静态 GET，不缓存 API 和事件流", async () => {
    const source = await readFile("public/sw.js", "utf8");

    expect(source).toContain('request.method !== "GET"');
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).toContain('request.headers.get("accept")?.includes("text/event-stream")');
    expect(source).toContain('"/brand/bugpaw/bugpaw-paw-icon-192.png"');
    expect(source).toContain('"/brand/bugpaw/bugpaw-paw-icon-512.png"');
    expect(source).not.toContain("/icons/icon.svg");
  });

  it("部署后优先获取最新脚本和样式，离线时才回退缓存", async () => {
    const source = await readFile("public/sw.js", "utf8");

    expect(source).toContain('const NETWORK_FIRST_DESTINATIONS = new Set(["script", "style"])');
    expect(source).toContain("NETWORK_FIRST_DESTINATIONS.has(request.destination)");
    expect(source).toContain("fetch(request).then(cacheResponse).catch(() => caches.match(request)");
  });

  it("使用新应用壳版本清除已安装 PWA 的旧入口缓存", async () => {
    const source = await readFile("public/sw.js", "utf8");

    expect(source).toContain('const CACHE_NAME = "bugpaw-shell-v10"');
  });
});
