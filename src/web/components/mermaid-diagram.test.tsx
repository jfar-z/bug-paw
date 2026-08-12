import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadMermaid } from "./mermaid-runtime";
import { MermaidDiagram } from "./mermaid-diagram";

vi.mock("./mermaid-runtime", () => ({
  loadMermaid: vi.fn(),
}));

const initialize = vi.fn();
const renderDiagram = vi.fn(async (id: string) => ({
  svg: `<svg role="img" aria-label="${id}"></svg>`,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadMermaid).mockResolvedValue({ initialize, render: renderDiagram });
});

describe("MermaidDiagram", () => {
  it("以 strict 安全级别渲染浅色 SVG", async () => {
    const { container } = render(<MermaidDiagram code={"graph TD\nA-->B"} theme="light" />);

    expect(screen.getByRole("status", { name: "正在渲染 Mermaid 图表" })).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector(".mermaid-diagram__canvas svg")).toBeInTheDocument());
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
    }));
  });

  it("主题变化后使用深色主题重新渲染", async () => {
    const { rerender } = render(<MermaidDiagram code={"graph TD\nA-->B"} theme="light" />);
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(1));

    rerender(<MermaidDiagram code={"graph TD\nA-->B"} theme="dark" />);

    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(2));
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
  });

  it("BUG 主题使用高对比品牌色板渲染时序图", async () => {
    render(<MermaidDiagram code={"sequenceDiagram\nA->>B: ping"} theme="bug" />);

    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(1));
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      theme: "base",
      themeVariables: expect.objectContaining({
        background: "#f1e7d8",
        primaryTextColor: "#2f241b",
        actorBorder: "#7a5a3a",
        actorLineColor: "#594634",
        signalColor: "#594634",
        signalTextColor: "#2f241b",
      }),
    }));
  });

  it("渲染失败时展示错误和可复制源码", async () => {
    renderDiagram.mockRejectedValueOnce(new Error("bad syntax"));
    render(<MermaidDiagram code={"broken"} theme="light" />);

    expect(await screen.findByText("Mermaid 图表渲染失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制代码" })).toBeInTheDocument();
    expect(screen.getByText("broken")).toBeInTheDocument();
  });

  it("源码可展开且多个实例使用不同渲染 ID", async () => {
    const { container } = render(
      <>
        <MermaidDiagram code={"graph TD\nA-->B"} theme="light" />
        <MermaidDiagram code={"graph TD\nB-->C"} theme="light" />
      </>,
    );
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(2));

    const ids = renderDiagram.mock.calls.map(([id]) => id);
    expect(new Set(ids).size).toBe(2);
    fireEvent.click(screen.getAllByRole("button", { name: "查看 Mermaid 源码" })[0]);
    expect(container.querySelector(".mermaid-diagram__source code")?.textContent).toBe("graph TD\nA-->B");
    expect(container.querySelector(".mermaid-diagram__source .highlighted-code-block"))
      .not.toHaveClass("is-line-wrapping");
  });
});
