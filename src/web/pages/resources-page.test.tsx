import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { ResourcesPage } from "./resources-page";

function renderResourcesPage() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><ResourcesPage /></ApiTaskProvider></ErrorToastProvider>);
}

describe("ResourcesPage", () => {
  it("筛选来源和类型、查看只读内容并标记高风险工具", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/content")) return new Response(JSON.stringify({ content: "# Skill 内容" }), { status: 200 });
      if (String(input) === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      return new Response(JSON.stringify({ resources: [
        { id: "skill:/demo", type: "skill", name: "demo", description: "示例技能", path: "/demo", source: "auto", scope: "global", origin: "top-level", enabled: true, inherited: true },
        { id: "prompt:/brief", type: "prompt", name: "brief", description: "摘要", path: "/brief", source: "auto", scope: "agent", origin: "top-level", enabled: true, inherited: false },
      ], tools: [{ name: "deploy", description: "部署", extensionPath: "/ext", highRisk: true }], diagnostics: [] }), { status: 200 });
    }));
    renderResourcesPage();
    expect(await screen.findByText("demo")).toBeInTheDocument();
    expect(screen.getByText("高风险")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("资源类型"), { target: { value: "skill" } });
    expect(screen.queryByText("brief")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看 demo" }));
    expect(await screen.findByText("# Skill 内容")).toBeInTheDocument();
  });

  it("在完整资源目录为空时让 BUG 等候第一项扩展，筛选无结果时不重复展示插画", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      return new Response(JSON.stringify({ resources: [], tools: [], packages: [], diagnostics: [] }), { status: 200 });
    }));

    renderResourcesPage();

    const emptyMascot = await screen.findByAltText("BUG 正在等候第一项扩展");
    expect(emptyMascot).toHaveAttribute("src", "/brand/bugpaw/bugpaw-sleeping.png");
    expect(screen.getByText("BUG 还在等第一项扩展")).toBeInTheDocument();
  });

  it("筛选已有资源但无匹配项时只显示轻量提示", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      return new Response(JSON.stringify({ resources: [
        { id: "skill:/demo", type: "skill", name: "demo", description: "示例技能", path: "/demo", source: "auto", scope: "global", origin: "top-level", enabled: true, inherited: false },
      ], tools: [], packages: [], diagnostics: [] }), { status: 200 });
    }));

    renderResourcesPage();
    await screen.findByText("demo");
    fireEvent.change(screen.getByLabelText("资源类型"), { target: { value: "prompt" } });

    expect(screen.getByText("没有匹配的资源。")).toBeInTheDocument();
    expect(screen.queryByAltText("BUG 正在等候第一项扩展")).not.toBeInTheDocument();
  });
});
