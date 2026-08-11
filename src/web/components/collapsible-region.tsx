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
    >
      <div className="collapsible-region__inner">{children}</div>
    </div>
  );
}
