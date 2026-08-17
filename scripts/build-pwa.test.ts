import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { injectPwaPrecache } from "./build-pwa.mjs";

/** PWA 构建递归收集入口与浏览器配置页分包。 */
describe("PWA 预缓存构建", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("递归注入入口、浏览器分包、imports 与 CSS", async () => {
    const root = await mkdtemp(join(tmpdir(), "pwa-build-")); roots.push(root);
    await mkdir(join(root, ".vite"), { recursive: true });
    await writeFile(join(root, "sw.js"), "const BUILD_ASSETS = __BUGPAW_PRECACHE__;", "utf8");
    await writeFile(join(root, ".vite/manifest.json"), JSON.stringify({
      "index.html": { file: "assets/main.js", isEntry: true, imports: ["shared"], css: ["assets/main.css"] },
      "src/web/pages/browser-automation-page.tsx": { file: "assets/browser.js", isDynamicEntry: true, imports: ["shared"], css: ["assets/browser.css"] },
      "src/web/pages/aigc-workbench-page.tsx": { file: "assets/aigc.js", isDynamicEntry: true, imports: ["shared"], css: ["assets/aigc.css"] },
      "src/web/pages/aigc-channels-page.tsx": { file: "assets/aigc-channels.js", isDynamicEntry: true, imports: ["shared"], css: ["assets/aigc-channels.css"] },
      shared: { file: "assets/shared.js" },
    }), "utf8");
    await injectPwaPrecache(root);
    const source = await readFile(join(root, "sw.js"), "utf8");
    for (const asset of ["/assets/main.js", "/assets/main.css", "/assets/browser.js", "/assets/browser.css", "/assets/aigc.js", "/assets/aigc.css", "/assets/aigc-channels.js", "/assets/aigc-channels.css", "/assets/shared.js"]) expect(source).toContain(asset);
    expect(source).not.toContain("__BUGPAW_PRECACHE__");
  });
});
