// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** 语音页专属布局只按页面加载，复用主题令牌且不牵连 AIGC 样式。 */
describe("语音配置样式边界", () => {
  it("懒加载页面持有列表与抽屉样式，应用入口不提前加载", async () => {
    const [app, main, global, source, css] = await Promise.all([
      readFile("src/web/app.tsx", "utf8"), readFile("src/web/main.tsx", "utf8"),
      readFile("src/web/styles.css", "utf8"), readFile("src/web/pages/tts-page.tsx", "utf8"), readFile("src/web/tts.css", "utf8"),
    ]);
    expect(app).toContain('lazy(() => import("./pages/tts-page")');
    expect(source).toContain('import "../tts.css"');
    expect(source).not.toContain("aigc-interface-config.css");
    for (const selector of [".tts-profile-list", ".tts-editor-fields"]) {
      expect(css).toContain(selector);
      expect(global).not.toContain(selector);
    }
    expect(main).not.toContain("tts.css");
    expect(app).not.toContain('import "./tts.css"');
  });

  it("样式使用主题令牌并覆盖手机布局，页面继续登记独立预算", async () => {
    const css = await readFile("src/web/tts.css", "utf8");
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
    expect(css).toContain("@media (max-width: 760px)");
    const budget = JSON.parse(await readFile("config/bundle-budget.json", "utf8"));
    expect(budget.css.routes["src/web/pages/tts-page.tsx"].gzipBytes).toBeGreaterThan(0);
  });
});
