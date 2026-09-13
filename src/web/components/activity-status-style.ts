import type { CSSProperties } from "react";

/** 统一活动区思考与工具调用的状态文字视觉。 */
export const activityStatusStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  color: "var(--text-primary)",
  fontFamily: '"Manrope Variable", Manrope, sans-serif',
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0,
  lineHeight: 1,
  whiteSpace: "nowrap",
} satisfies CSSProperties;
