import { Check, Copy } from "lucide-react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { useEffect, useMemo, useState } from "react";

const LANGUAGE_ALIASES: Record<string, string> = {
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  patch: "diff",
  py: "python",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

interface HighlightedCodeBlockProps {
  code: string;
  language?: string;
}

/**
 * 渲染带语言标签、语法高亮和复制反馈的代码块。
 */
export function HighlightedCodeBlock({ code, language }: HighlightedCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const normalizedLanguage = normalizeLanguage(language);
  const highlighted = useMemo(() => normalizedLanguage && hljs.getLanguage(normalizedLanguage)
    ? hljs.highlight(code, { language: normalizedLanguage }).value
    : escapeHtml(code), [code, normalizedLanguage]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1_800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyCode(): Promise<void> {
    await copyText(code);
    setCopied(true);
  }

  return (
    <div className="highlighted-code-block">
      <div className="highlighted-code-block__toolbar">
        <span>{language || "text"}</span>
        <button type="button" aria-label={copied ? "代码已复制" : "复制代码"} onClick={() => void copyCode()}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
    </div>
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  // 局域网 HTTP 通常不提供 Clipboard API，使用短生命周期文本框兼容复制。
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy") ?? false;
  textarea.remove();
  if (!copied) {
    throw new Error("浏览器不支持自动复制");
  }
}

function normalizeLanguage(language?: string): string | undefined {
  if (!language) {
    return undefined;
  }
  const normalized = language.toLowerCase();
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

/**
 * 未知语言不交给高亮器时仍需转义，避免代码被解释为 HTML。
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
