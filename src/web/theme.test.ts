import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, readThemePreference, resolveTheme, THEME_STORAGE_KEY } from "./theme";

afterEach(() => {
  window.localStorage.clear();
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("resolveTheme", () => {
  it("保留明确选择的浅色主题", () => {
    expect(resolveTheme("light")).toBe("light");
  });

  it("保留明确选择的深色主题", () => {
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("没有有效存储主题时默认使用 BUG 主题", () => {
    expect(readThemePreference()).toBe("bug");
  });

  it("将旧版跟随系统记录迁移为 BUG 主题", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");

    expect(readThemePreference()).toBe("bug");
  });

  it("保留明确选择的 BUG 主题", () => {
    expect(resolveTheme("bug")).toBe("bug");
  });

  it("从原有存储键恢复 BUG 主题", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "bug");

    expect(readThemePreference()).toBe("bug");
    expect(THEME_STORAGE_KEY).toBe("pi-agent-theme");
  });

  it.each([
    ["dark", "#151517"],
    ["light", "#f7f6f2"],
    ["bug", "#ded2bf"],
  ] as const)("为 %s 主题同步浏览器颜色", (preference, expectedColor) => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000">';
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));

    expect(applyTheme(preference)).toBe(preference);
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", expectedColor);
  });
});
