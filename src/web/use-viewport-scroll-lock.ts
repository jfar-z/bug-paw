import { useLayoutEffect } from "react";

/**
 * 在全屏对话页生命周期内关闭浏览器根滚动，并在卸载时恢复原值。
 */
export function useViewportScrollLock(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const rootOverflow = root.style.overflow;
    const bodyOverflow = body.style.overflow;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";

    return () => {
      root.style.overflow = rootOverflow;
      body.style.overflow = bodyOverflow;
    };
  }, []);
}
