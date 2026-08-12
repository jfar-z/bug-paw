import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const applicationStyles = await readFile("src/web/styles.css", "utf8");

describe("活动卡片首行对齐", () => {
  it("让工具与思考卡片的辅助列贴齐标题首行", () => {
    expect(applicationStyles).toMatch(/\.live-tool-card__summary,\s*\.thinking-card__summary\s*\{[^}]*align-items:\s*start;/s);
  });

  it("不改变顶部活动摘要并让圆点中心落在时间线中心", () => {
    expect(applicationStyles).toMatch(/\.activity-group__summary\s*\{[^}]*align-items:\s*center;/s);
    expect(applicationStyles).toMatch(/\.activity-rail\s*\{[^}]*padding-left:\s*15px;/s);
    expect(applicationStyles).toMatch(/\.live-tool-card::before,\s*\.thinking-card::before\s*\{[^}]*left:\s*-18\.5px;/s);
  });
});
