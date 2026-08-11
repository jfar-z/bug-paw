import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMermaid } from "./mermaid-runtime";
import { MarkdownContent } from "./markdown-content";

vi.mock("./mermaid-runtime", () => ({
  loadMermaid: vi.fn(),
}));

const renderDiagram = vi.fn(async () => ({ svg: '<svg role="img" aria-label="流程图"></svg>' }));

beforeEach(() => {
  renderDiagram.mockClear();
  vi.mocked(loadMermaid).mockResolvedValue({
    initialize: vi.fn(),
    render: renderDiagram,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function MermaidWithUnrelatedDraft() {
  const [draft, setDraft] = useState("");
  return (
    <>
      <input aria-label="无关草稿" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <MarkdownContent text={"```mermaid\ngraph TD\nA-->B\n```"} streaming={false} theme="light" />
    </>
  );
}

describe("MarkdownContent", () => {
  it("渲染常用 Markdown 与 GFM 结构", () => {
    const text = [
      "# 标题",
      "",
      "- 列表项",
      "",
      "| 名称 | 状态 |",
      "| --- | --- |",
      "| 构建 | 通过 |",
      "",
      "[外部链接](https://example.com)",
      "",
      "行内 `code`",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n");

    const { container } = render(<MarkdownContent text={text} />);

    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "外部链接" })).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(container.querySelector("pre code")).toHaveTextContent("const value = 1;");
  });

  it("流式文本补全后重新解析 Markdown 结构", () => {
    const { rerender } = render(<MarkdownContent text="**正在生成" />);
    expect(screen.queryByText("正在生成", { selector: "strong" })).not.toBeInTheDocument();

    rerender(<MarkdownContent text="**正在生成**" />);

    expect(screen.getByText("正在生成", { selector: "strong" })).toBeInTheDocument();
  });

  it("流式正文保持单一渐变状态，不为每个增量重启动画", () => {
    let pendingFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      pendingFrame = callback;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { container, rerender } = render(<MarkdownContent text="实时" streaming />);
    rerender(<MarkdownContent text="实时正文" streaming />);

    act(() => pendingFrame?.(16));

    const content = container.querySelector(".markdown-content.is-text-revealing");
    expect(content).toBeInTheDocument();
    expect(content).not.toHaveClass("is-text-revealing--1");
  });

  it("只为本次新增的 Markdown 尾部文字添加渐变", () => {
    const { container } = render(
      <MarkdownContent text="实时正文" streaming revealStart={2} revealPhase={1} />,
    );

    expect(container.querySelector(".streaming-text-tail--1")).toHaveTextContent("正文");
    expect(container.querySelector(".markdown-content")).toHaveTextContent("实时正文");
  });

  it("不把原始 HTML 转换成可执行节点", () => {
    const { container } = render(<MarkdownContent text={'<script>alert(1)</script><img src="x" onerror="alert(2)">'} />);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("<script>alert(1)</script>");
  });

  it("区分行内代码与带复制按钮的代码块", () => {
    const { container } = render(<MarkdownContent text={'行内 `value`\n\n```ts\nconst value = 1;\n```'} />);

    expect(container.querySelector("p code")).toHaveTextContent("value");
    expect(screen.getByRole("button", { name: "复制代码" })).toBeInTheDocument();
    expect(container.querySelector(".highlighted-code-block code.hljs")).toBeInTheDocument();
  });

  it("渲染行内与块级数学公式", () => {
    const { container } = render(<MarkdownContent text={'行内公式 $E=mc^2$\n\n$$\n\\int_0^1 x^2 dx\n$$'} />);

    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelector(".katex-display")).toBeInTheDocument();
  });

  it("兼容反斜杠数学定界符且不转换代码内容", () => {
    const text = [
      String.raw`正态分布 \(\mathcal{N}(\mu, \sigma^2)\)`,
      "",
      "\\[",
      String.raw`\int_0^1 x^2 dx`,
      "\\]",
      "",
      "代码 `\\(not_math\\)`",
    ].join("\n");
    const { container } = render(<MarkdownContent text={text} />);

    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelector(".katex-display")).toBeInTheDocument();
    expect(container.querySelector("p code")).toHaveTextContent(String.raw`\(not_math\)`);
  });

  it("仅在流式完成后把 mermaid 围栏转换为图表", async () => {
    const text = "```mermaid\ngraph TD\nA-->B\n```";
    const { container, rerender } = render(<MarkdownContent text={text} streaming theme="light" />);

    expect(container.querySelector(".mermaid-diagram")).toBeNull();
    expect(container.querySelector(".highlighted-code-block")).not.toHaveClass("is-line-wrapping");
    expect(loadMermaid).not.toHaveBeenCalled();

    rerender(<MarkdownContent text={text} streaming={false} theme="light" />);

    expect(await screen.findByRole("img", { name: "流程图" })).toBeInTheDocument();
  });

  it("父级无关状态更新时保留已完成的 Mermaid 图表", async () => {
    render(<MermaidWithUnrelatedDraft />);
    expect(await screen.findByRole("img", { name: "流程图" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "无关草稿" }), { target: { value: "a" } });

    expect(await screen.findByRole("img", { name: "流程图" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在渲染 Mermaid 图表" })).not.toBeInTheDocument();
    expect(renderDiagram).toHaveBeenCalledTimes(1);
  });
});
