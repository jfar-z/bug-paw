import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { checkBundle } from "./check-bundle.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 构造包含入口样式、页面样式和未登记样式的最小生产构建。 */
async function createBundle(budgets: { entry: number; total: number; route: number }, budgetOther = true) {
  const root = await mkdtemp(join(tmpdir(), "bundle-budget-"));
  roots.push(root);
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "dist/web/.vite"), { recursive: true });
  await mkdir(join(root, "dist/web/assets"), { recursive: true });
  const files = {
    "main.js": "export const main = true;",
    "aigc.js": "export const page = true;",
    "other.js": "export const other = true;",
    "main.css": ".shell{display:grid}",
    "aigc.css": ".aigc{display:flex}",
    "other.css": ".other{display:block}",
  };
  await Promise.all(Object.entries(files).map(([name, source]) => (
    writeFile(join(root, "dist/web/assets", name), source, "utf8")
  )));
  await writeFile(join(root, "dist/web/.vite/manifest.json"), JSON.stringify({
    "index.html": { file: "assets/main.js", isEntry: true, css: ["assets/main.css"], dynamicImports: ["src/web/pages/aigc.tsx"] },
    "src/web/pages/aigc.tsx": { file: "assets/aigc.js", isDynamicEntry: true, imports: ["index.html"], css: ["assets/aigc.css"] },
    "src/web/pages/other.tsx": { file: "assets/other.js", isDynamicEntry: true, css: ["assets/other.css"] },
  }), "utf8");
  await writeFile(join(root, "config/bundle-budget.json"), JSON.stringify({
    entryJsGzipBytes: 1024,
    lazyChunkGzipBytes: 1024,
    css: {
      entryGzipBytes: budgets.entry,
      totalGzipBytes: budgets.total,
      routes: {
        "src/web/pages/aigc.tsx": { label: "AIGC", gzipBytes: budgets.route },
        ...(budgetOther ? { "src/web/pages/other.tsx": { label: "其他页面", gzipBytes: 1024 } } : {}),
      },
    },
  }), "utf8");
  return { root, files };
}

describe("Bundle 分层 CSS 预算", () => {
  it("分别统计首屏、页面增量与全站 CSS", async () => {
    const { root, files } = await createBundle({ entry: 1024, total: 1024, route: 1024 });
    const result = await checkBundle(root);

    expect(result.violations).toEqual([]);
    expect(result.css.entryBytes).toBe(gzipSync(files["main.css"]).byteLength);
    expect(result.css.totalBytes).toBe(
      gzipSync(files["main.css"]).byteLength
      + gzipSync(files["aigc.css"]).byteLength
      + gzipSync(files["other.css"]).byteLength,
    );
    expect(result.css.routes).toEqual(expect.arrayContaining([expect.objectContaining({
      label: "AIGC",
      bytes: gzipSync(files["aigc.css"]).byteLength,
    })]));
  });

  it("独立报告首屏、页面和总量超限", async () => {
    const { root } = await createBundle({ entry: 1, total: 1, route: 1 });
    const result = await checkBundle(root);

    expect(result.violations).toEqual([
      expect.stringMatching(/^CSS 首屏:/u),
      expect.stringMatching(/^CSS 总量:/u),
      expect.stringMatching(/^CSS 页面 AIGC:/u),
    ]);
  });

  it("拒绝未登记预算的懒加载页面", async () => {
    const { root } = await createBundle({ entry: 1024, total: 1024, route: 1024 }, false);
    const result = await checkBundle(root);

    expect(result.violations).toContain("CSS 页面预算缺失: src/web/pages/other.tsx");
  });
});
