// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** 渠道页与语音页共享弹层逻辑，专属样式不能回流至应用壳。 */
describe("渠道配置样式边界", () => {
  it("页面加载专属样式，抽屉只加载共享布局而非其他业务页样式", async () => {
    const source = await readFile("src/web/pages/aigc-channels-page.tsx", "utf8");
    const dialog = await readFile("src/web/components/configuration/configuration-editor-dialog.tsx", "utf8");
    expect(source).toContain('import "../aigc-channels.css"');
    expect(dialog).toContain('import "../../configuration-editor-dialog.css"');
    for (const other of ["aigc-interface-config.css", "tts.css", 'import "../aigc.css"']) expect(source).not.toContain(other);
    for (const file of ["src/web/main.tsx", "src/web/app.tsx", "src/web/styles.css"]) {
      const text = await readFile(file, "utf8");
      expect(text).not.toContain("configuration-editor-dialog.css");
      expect(text).not.toContain("aigc-channels.css");
      expect(text).not.toContain(".aigc-channel-row");
    }
  });
  it("所有新增布局继承主题令牌并覆盖手机视口", async () => {
    for (const file of ["src/web/aigc-channels.css", "src/web/configuration-editor-dialog.css"]) {
      const css = await readFile(file, "utf8");
      expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
      expect(css).toContain("@media (max-width: 760px)");
    }
  });
});
