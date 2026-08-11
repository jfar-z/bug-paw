import { ChevronDown, ChevronRight, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ThemePreference } from "../theme";
import { HighlightedCodeBlock } from "./highlighted-code-block";
import { loadMermaid } from "./mermaid-runtime";

interface MermaidDiagramProps {
  code: string;
  theme: ThemePreference;
}

type RenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error" };

interface MermaidThemeConfiguration {
  theme: "neutral" | "dark" | "base";
  themeVariables?: Record<string, string>;
}

/**
 * BUG 主题的 Mermaid 色板只复用现行品牌色，确保线条与奶油背景保持清晰对比。
 */
const bugMermaidThemeVariables: Record<string, string> = {
  background: "#f1e7d8",
  primaryColor: "#f1e7d8",
  secondaryColor: "#cdba9f",
  tertiaryColor: "#ded2bf",
  primaryTextColor: "#2f241b",
  primaryBorderColor: "#7a5a3a",
  lineColor: "#594634",
  arrowheadColor: "#594634",
  textColor: "#2f241b",
  mainBkg: "#f1e7d8",
  nodeBorder: "#7a5a3a",
  nodeTextColor: "#2f241b",
  defaultLinkColor: "#594634",
  edgeLabelBackground: "#f1e7d8",
  actorBorder: "#7a5a3a",
  actorBkg: "#f1e7d8",
  actorTextColor: "#2f241b",
  actorLineColor: "#594634",
  signalColor: "#594634",
  signalTextColor: "#2f241b",
  labelBoxBkgColor: "#cdba9f",
  labelBoxBorderColor: "#7a5a3a",
  labelTextColor: "#2f241b",
  loopTextColor: "#2f241b",
  noteBorderColor: "#7a5a3a",
  noteBkgColor: "#cdba9f",
  noteTextColor: "#2f241b",
  activationBorderColor: "#7a5a3a",
  activationBkgColor: "#ded2bf",
  sequenceNumberColor: "#fff9ee",
};

/**
 * 以严格安全模式异步渲染 Mermaid，并保留源码与失败回退。
 */
export function MermaidDiagram({ code, theme }: MermaidDiagramProps) {
  const reactId = useId();
  const [renderState, setRenderState] = useState<RenderState>({ status: "loading" });
  const [sourceVisible, setSourceVisible] = useState(false);
  const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    let active = true;
    setRenderState({ status: "loading" });
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          ...resolveMermaidTheme(theme),
        });
        return mermaid.render(renderId, code);
      })
      .then(({ svg }) => {
        if (active) {
          setRenderState({ status: "ready", svg });
        }
      })
      .catch(() => {
        if (active) {
          setRenderState({ status: "error" });
          setSourceVisible(true);
        }
      });
    return () => {
      active = false;
    };
  }, [code, renderId, theme]);

  return (
    <section className={`mermaid-diagram is-${renderState.status}`}>
      <div className="mermaid-diagram__toolbar">
        <span>mermaid</span>
        <button
          type="button"
          aria-expanded={sourceVisible}
          aria-label={sourceVisible ? "收起 Mermaid 源码" : "查看 Mermaid 源码"}
          onClick={() => setSourceVisible((current) => !current)}
        >
          {sourceVisible ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          <span>{sourceVisible ? "收起源码" : "查看源码"}</span>
        </button>
      </div>
      {renderState.status === "loading" && (
        <div className="mermaid-diagram__status" role="status" aria-label="正在渲染 Mermaid 图表">
          <LoaderCircle className="is-spinning" size={17} aria-hidden="true" />
          <span>正在渲染图表…</span>
        </div>
      )}
      {renderState.status === "error" && (
        <div className="mermaid-diagram__status is-error" role="alert">
          <TriangleAlert size={17} aria-hidden="true" />
          <span>Mermaid 图表渲染失败</span>
        </div>
      )}
      {renderState.status === "ready" && (
        <div className="mermaid-diagram__canvas" dangerouslySetInnerHTML={{ __html: renderState.svg }} />
      )}
      {sourceVisible && (
        <div className="mermaid-diagram__source">
          <HighlightedCodeBlock code={code} language="mermaid" wrapLines={false} />
        </div>
      )}
    </section>
  );
}

function resolveMermaidTheme(theme: ThemePreference): MermaidThemeConfiguration {
  if (theme === "dark") {
    return { theme: "dark" };
  }
  if (theme === "bug") {
    return { theme: "base", themeVariables: bugMermaidThemeVariables };
  }
  return { theme: "neutral" };
}
