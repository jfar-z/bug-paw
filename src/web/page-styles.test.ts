// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** 保护配置目录与文件浏览器边界，避免重构样式回流首屏或删除工作区规则。 */
describe("资源页面样式加载边界", () => {
  it("资源配置样式只从懒加载页面进入，不加载文件浏览器整份 CSS", async () => {
    const [app, main, page] = await Promise.all(["src/web/app.tsx", "src/web/main.tsx", "src/web/pages/resources-page.tsx"].map((path) => readFile(path, "utf8")));
    expect(app).toContain('lazy(() => import("./pages/resources-page")');
    expect(page).toContain('import "../resource-catalog.css"');
    expect(page).not.toContain('import "../resources.css"');
    expect(main).not.toContain("resource-catalog.css");
    expect(app).not.toContain("resource-catalog.css");
  });
  it("文件浏览器仍保留独立空态、手机预览及快捷抽屉布局", async () => {
    const [page, css] = await Promise.all(["src/web/pages/workspace-resources-page.tsx", "src/web/resources.css"].map((path) => readFile(path, "utf8")));
    expect(page).toContain('import "../resources.css"');
    for (const selector of [".workspace-resources-page__empty-state", ".workspace-file-preview", ".quick-workspace-drawer", ".workspace-table-wrap"]) expect(css).toContain(selector);
    expect(css).not.toContain(".resource-grid");
  });
});

/** 四页维护样式不能回流应用壳，共享弹层仍按组件加载。 */
describe("配置维护页加载边界", () => {
  it("四页仅通过懒加载入口引入维护领域 CSS", async () => {
    const main = await readFile("src/web/main.tsx", "utf8");
    const app = await readFile("src/web/app.tsx", "utf8");
    expect(main).not.toContain("configuration-maintenance.css"); expect(app).not.toContain("configuration-maintenance.css");
    for (const page of ["browser-automation-page", "knowledge-retrieval-page", "configuration-operations-page", "configuration-overview-page"]) {
      expect(app).toContain(`lazy(() => import("./pages/${page}")`);
      expect(await readFile(`src/web/pages/${page}.tsx`, "utf8")).toContain('import "../configuration-maintenance.css"');
    }
  });
});
