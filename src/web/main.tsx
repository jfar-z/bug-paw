import "@fontsource-variable/manrope";
import "@fontsource/jetbrains-mono/400.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { applyTheme, readThemePreference } from "./theme";
import "./styles.css";
import "./bugpaw-theme.css";

// React 挂载前设置主题，避免页面出现浅深色闪烁。
applyTheme(readThemePreference());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 仅在生产环境注册应用壳缓存，开发时避免旧资源干扰调试。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("PWA service worker 注册失败", error);
    });
  });
}
