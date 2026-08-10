import { useEffect, useState } from "react";

interface StreamingTextReveal {
  visibleText: string;
  isRevealing: boolean;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 直接展示 SSE 源文本，并在流式期间维持稳定的渐变状态。
 */
export function useStreamingTextReveal(text: string, streaming: boolean): StreamingTextReveal {
  const [reducedMotion, setReducedMotion] = useState(readReducedMotionPreference);
  useEffect(() => {
    const mediaQuery = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!mediaQuery) {
      return undefined;
    }
    const updatePreference = () => setReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return {
    visibleText: text,
    isRevealing: streaming && !reducedMotion && text.length > 0,
  };
}

/**
 * 在首次渲染阶段读取用户的减少动态效果偏好，避免先播放一帧动画。
 */
function readReducedMotionPreference(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true;
}
