export type ThemePreference = "light" | "dark" | "bug";
export type ResolvedTheme = "light" | "dark" | "bug";

export const THEME_STORAGE_KEY = "pi-agent-theme";

/**
 * 根据用户偏好解析最终主题。
 */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference;
}

/**
 * 从本地存储读取经过校验的主题偏好。
 */
export function readThemePreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "bug") {
    return stored;
  }

  return "bug";
}

/**
 * 将主题应用到文档根节点和浏览器主题色。
 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const browserThemeColors: Record<ResolvedTheme, string> = {
    dark: "#151517",
    light: "#f7f6f2",
    bug: "#ded2bf",
  };
  themeColor?.setAttribute("content", browserThemeColors[resolved]);
  return resolved;
}
