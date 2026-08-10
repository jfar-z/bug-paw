import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HighlightedCodeBlock } from "./highlighted-code-block";

describe("HighlightedCodeBlock", () => {
  it("高亮已知语言并展示语言标签", () => {
    const { container } = render(<HighlightedCodeBlock code="const answer = 42;" language="typescript" />);

    expect(screen.getByText("typescript")).toBeInTheDocument();
    expect(container.querySelector("code.hljs .hljs-keyword")).toHaveTextContent("const");
  });

  it("未知语言回退为安全纯文本", () => {
    const { container } = render(<HighlightedCodeBlock code={'<script>alert("x")</script>'} language="unknown-lang" />);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("code")).toHaveTextContent('<script>alert("x")</script>');
  });

  it("复制完整代码并短暂展示成功反馈", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<HighlightedCodeBlock code="echo hello" language="bash" />);

    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("echo hello"));
    expect(screen.getByRole("button", { name: "代码已复制" })).toBeInTheDocument();
  });

  it("非安全上下文没有 Clipboard API 时使用兼容复制", async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    render(<HighlightedCodeBlock code="pwd" language="bash" />);

    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(screen.getByRole("button", { name: "代码已复制" })).toBeInTheDocument();
  });

  it("为 diff 和 patch 展示新增与删除语义高亮", () => {
    const code = "@@ -1 +1 @@\n-old value\n+new value";
    const { container, rerender } = render(<HighlightedCodeBlock code={code} language="diff" />);

    expect(container.querySelector(".hljs-deletion")).toHaveTextContent("-old value");
    expect(container.querySelector(".hljs-addition")).toHaveTextContent("+new value");
    expect(screen.getByText("diff")).toBeInTheDocument();

    rerender(<HighlightedCodeBlock code={code} language="patch" />);
    expect(container.querySelector(".hljs-deletion")).toBeInTheDocument();
    expect(container.querySelector(".hljs-addition")).toBeInTheDocument();
    expect(screen.getByText("patch")).toBeInTheDocument();
  });
});
