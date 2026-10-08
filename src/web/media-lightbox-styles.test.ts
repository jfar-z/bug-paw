import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** 灯箱入口需独立加载领域样式，避免直接访问 AIGC 页面时依赖聊天页访问历史。 */
describe("媒体灯箱样式加载边界", () => {
  it.each([
    "components/media-lightbox.tsx",
    "pages/aigc-workbench-page.tsx",
    "pages/aigc-outputs-page.tsx",
  ])("%s 自行加载共享灯箱样式", async (entry) => {
    const source = await readFile(new URL(entry, import.meta.url), "utf8");
    expect(source).toContain('import "../media-lightbox.css";');
  });

  it("灯箱基础布局不进入首屏或重复归属单个页面", async () => {
    for (const file of ["styles.css", "chat.css", "aigc-assets.css"]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/\.media-lightbox\s*\{/);
    }
  });
});
