import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, CircleSlash2, LoaderCircle, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { formatToolValue, type ToolBlock } from "../conversation-timeline";
import { toolActivityCopy, toolStatusCopy } from "../features/chat/tool-activity-copy";

interface LiveToolCardProps {
  tool: ToolBlock;
}

/**
 * 在活动轨迹中展示可折叠的工具入参、实时输出和最终结果。
 */
export function LiveToolCard({ tool }: LiveToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const output = tool.status === "running" ? tool.partialResult : tool.result;
  const active = tool.status === "preparing" || tool.status === "running";
  const statusIcon = active
    ? <LoaderCircle className="spinner" size={14} aria-hidden="true" />
    : tool.status === "error"
      ? <CircleAlert size={14} aria-hidden="true" />
      : tool.status === "cancelled"
        ? <CircleSlash2 size={14} aria-hidden="true" />
        : <CheckCircle2 size={14} aria-hidden="true" />;

  return (
    <section className={`live-tool-card is-${tool.status}`}>
      <button
        type="button"
        className="live-tool-card__summary"
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "展开"} ${tool.name} 工具详情`}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <TerminalSquare size={17} aria-hidden="true" />
        <strong>{toolActivityCopy(tool)}</strong>
        <span className="live-tool-card__status">{statusIcon}<span>{toolStatusCopy(tool)}</span></span>
      </button>

      {expanded && (
        <div className="live-tool-card__details">
          <ToolDetail title="入参" value={tool.args} />
          <ToolDetail title="结果" value={output} />
          {hasToolDetailValue(tool.details) && <ToolDetail title="详情" value={tool.details} />}
        </div>
      )}
    </section>
  );
}

/** 判断可选详情是否包含值得展示的信息。 */
export function hasToolDetailValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function ToolDetail({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="live-tool-card__detail">
      <h4>{title}</h4>
      <pre><code>{formatToolValue(value)}</code></pre>
    </section>
  );
}
