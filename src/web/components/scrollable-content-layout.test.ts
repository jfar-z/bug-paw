import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const applicationStyles = await readFile("src/web/styles.css", "utf8");
let styleElement: HTMLStyleElement;

beforeAll(() => {
  styleElement = document.createElement("style");
  styleElement.textContent = applicationStyles;
  document.head.append(styleElement);
});

afterAll(() => styleElement.remove());

describe("长内容滚动布局", () => {
  it("让会话搜索结果占据可收缩轨道并独立滚动", () => {
    document.body.innerHTML = `
      <section class="configuration-dialog session-search-dialog">
        <div class="session-search-dialog__results"></div>
      </section>`;

    const dialog = getComputedStyle(document.querySelector<HTMLElement>(".session-search-dialog")!);
    const results = getComputedStyle(document.querySelector<HTMLElement>(".session-search-dialog__results")!);
    expect(dialog.gridTemplateRows).toBe("auto auto auto minmax(0, 1fr) auto");
    expect(results.minHeight).toBe("0px");
    expect(results.overflowY).toBe("auto");
    expect(results.overscrollBehaviorY).toBe("contain");
  });
});
