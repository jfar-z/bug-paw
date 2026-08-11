import type { ReactNode } from "react";

interface CollapsibleRegionProps {
  expanded: boolean;
  className: string;
  children: ReactNode;
}

/** 为活动详情提供一致的折叠结构与可访问状态。 */
export function CollapsibleRegion({ expanded, className, children }: CollapsibleRegionProps) {
  return (
    <div
      className={`collapsible-region ${className}${expanded ? " is-expanded" : ""}`}
      aria-hidden={!expanded}
      style={{
        display: "grid",
        gridTemplateRows: expanded ? "1fr" : "0fr",
        opacity: expanded ? 1 : 0,
        transform: expanded ? "none" : "translateY(-2px)",
        transition: "grid-template-rows 180ms ease, opacity 180ms ease, transform 180ms ease",
      }}
    >
      <div className="collapsible-region__inner">{children}</div>
    </div>
  );
}
