// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { checkBundle } from "./check-bundle.mjs";
import { injectPwaPrecache } from "./build-pwa.mjs";

const roots: string[] = [];
const page = "src/web/pages/aigc-interfaces-page.tsx";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** 独立页面必须登记预算，样式仅计入页面增量且进入 PWA 预缓存。 */
describe("接口配置分包合同", () => {
  it("共享样式去重，首屏不承担接口配置专属样式", async () => {
    const root = await fixture();
    const result = await checkBundle(root);
    expect(result.violations).toEqual([]);
    expect(result.css.entryBytes).toBe(gzipSync("body{}").byteLength);
    expect(result.css.routes[0].bytes).toBe(gzipSync(".aigc-config-drawer{}").byteLength);
  });

  it("遗漏页面登记或超出预算会阻止构建门禁", async () => {
    const root = await fixture();
    const path = join(root, "config/bundle-budget.json");
    const budget = JSON.parse(await readFile(path, "utf8"));
    delete budget.css.routes[page];
    await writeFile(path, JSON.stringify(budget), "utf8");
    expect((await checkBundle(root)).violations).toContain(`CSS 页面预算缺失: ${page}`);
    budget.css.routes[page] = { label: "接口配置", gzipBytes: 1 };
    await writeFile(path, JSON.stringify(budget), "utf8");
    expect((await checkBundle(root)).violations.some((message: string) => message.startsWith("CSS 页面 接口配置:"))).toBe(true);
  });

  it("新页面脚本、样式及递归共享依赖全部预缓存且去重", async () => {
    const root = await fixture();
    const output = join(root, "dist/web");
    await injectPwaPrecache(output);
    const assets = JSON.parse((await readFile(join(output, "sw.js"), "utf8")).slice("const assets = ".length, -1));
    expect(assets).toEqual(["/entry.css", "/entry.js", "/interfaces.css", "/interfaces.js", "/shared.js"]);
  });

  it("真实页面使用懒加载，专属样式不回流到应用入口", async () => {
    const source = await readFile("src/web/pages/aigc-interfaces-page.tsx", "utf8");
    const parent = await readFile("src/web/pages/aigc-workbench-page.tsx", "utf8");
    const main = await readFile("src/web/main.tsx", "utf8");
    expect(parent).toContain('await import("./aigc-interfaces-page")');
    expect(source).toContain('import "../aigc-interface-config.css"');
    expect(parent).not.toContain('import "../aigc-interface-config.css"');
    expect(main).not.toContain("aigc-interface-config.css");
  });
});

/** 临时构建产物只用于测试门禁算法，不替代真实生产构建。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-interface-bundle-"));
  roots.push(root);
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "dist/web/.vite"), { recursive: true });
  const output = join(root, "dist/web");
  await Promise.all([
    writeFile(join(root, "config/bundle-budget.json"), JSON.stringify({ entryJsGzipBytes: 1000, lazyChunkGzipBytes: 1000, css: { entryGzipBytes: 1000, totalGzipBytes: 2000, routes: { [page]: { label: "接口配置", gzipBytes: 1000 } } } }), "utf8"),
    writeFile(join(output, ".vite/manifest.json"), JSON.stringify({ "index.html": { file: "entry.js", isEntry: true, css: ["entry.css"] }, [page]: { file: "interfaces.js", isDynamicEntry: true, imports: ["shared"], css: ["interfaces.css"] }, shared: { file: "shared.js", css: ["entry.css"] } }), "utf8"),
    writeFile(join(output, "entry.js"), "export {};", "utf8"),
    writeFile(join(output, "interfaces.js"), "export {};", "utf8"),
    writeFile(join(output, "shared.js"), "export {};", "utf8"),
    writeFile(join(output, "entry.css"), "body{}", "utf8"),
    writeFile(join(output, "interfaces.css"), ".aigc-config-drawer{}", "utf8"),
    writeFile(join(output, "sw.js"), "const assets = __BUGPAW_PRECACHE__;", "utf8"),
  ]);
  return root;
}
