import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface StyleBoundary {
  /** 页面领域样式文件。 */
  stylesheet: string;
  /** 用于确认样式已经离开首屏入口的代表选择器。 */
  selector: string;
  /** 必须显式加载该领域样式的页面入口。 */
  pages: string[];
}

const boundaries: StyleBoundary[] = [
  { stylesheet: "agents.css", selector: ".agent-card", pages: ["agents-page.tsx", "agent-detail-page.tsx"] },
  { stylesheet: "providers.css", selector: ".provider-workspace", pages: ["providers-page.tsx"] },
  { stylesheet: "pi-settings.css", selector: ".settings-scope-bar", pages: ["pi-settings-page.tsx"] },
  { stylesheet: "resources.css", selector: ".workspace-resources-page", pages: ["resources-page.tsx", "workspace-resources-page.tsx", "scheduled-tasks-page.tsx", "chat-page.tsx"] },
  { stylesheet: "scheduled-tasks.css", selector: ".scheduled-task-card", pages: ["scheduled-tasks-page.tsx"] },
  { stylesheet: "knowledge-base.css", selector: ".knowledge-base-page", pages: ["knowledge-base-page.tsx"] },
  { stylesheet: "chat.css", selector: ".chat-sidebar", pages: ["chat-page.tsx"] },
  { stylesheet: "aigc-assets.css", selector: ".aigc-assets-page", pages: ["aigc-outputs-page.tsx"] },
  { stylesheet: "aigc-workflow-composer.css", selector: ".aigc-node-navigator", pages: ["aigc-workflow-composer.tsx"] },
];

describe("独立页面样式边界", () => {
  it("页面专属规则离开首屏样式并由对应入口加载", async () => {
    const globalStyles = await readFile("src/web/styles.css", "utf8");

    for (const boundary of boundaries) {
      const pageStyles = await readFile(`src/web/${boundary.stylesheet}`, "utf8");
      expect(globalStyles).not.toContain(boundary.selector);
      expect(pageStyles).toContain(boundary.selector);
      for (const page of boundary.pages) {
        const source = await readFile(`src/web/pages/${page}`, "utf8");
        expect(source).toContain(`import "../${boundary.stylesheet}";`);
      }
    }
  });

  it("工作流编排器按详情路由懒加载", async () => {
    const [aigcStyles, pageSource] = await Promise.all([
      readFile("src/web/aigc.css", "utf8"),
      readFile("src/web/pages/aigc-workbench-page.tsx", "utf8"),
    ]);

    expect(aigcStyles).not.toContain(".aigc-node-navigator");
    expect(pageSource).toContain('import("./aigc-workflow-composer")');
    expect(pageSource).toContain("<Suspense");
  });

  it("Markdown 内容样式跟随内容组件加载", async () => {
    const [globalStyles, contentStyles, componentSource] = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("src/web/markdown-content.css", "utf8"),
      readFile("src/web/components/markdown-content.tsx", "utf8"),
    ]);

    expect(globalStyles).not.toContain(".markdown-content");
    expect(contentStyles).toContain(".markdown-content");
    expect(componentSource).toContain('import "../markdown-content.css";');
  });
});
