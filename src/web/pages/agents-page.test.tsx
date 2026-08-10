import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentsPage } from "./agents-page";

describe("AgentsPage", () => {
  it("读取真实 Agent 数据并创建新 Agent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ profile: { id: "new-id", name: "新助手", cwd: "/data/workspace/agents/new-id", status: "active", description: "", defaultModel: undefined }, revision: "r2" }), { status: 201 });
      }
      return new Response(JSON.stringify({ agents: [{ profile: { id: "real", name: "真实 Agent", cwd: "/data/workspace/agents/real", status: "active", description: "真实数据" }, revision: "r1" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onNavigate = vi.fn();
    render(<AgentsPage onNavigate={onNavigate} />);

    expect(await screen.findByText("真实 Agent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建 Agent" }));
    fireEvent.change(screen.getByLabelText("Agent 名称"), { target: { value: "新助手" } });
    fireEvent.click(screen.getByRole("button", { name: "使用自定义目录" }));
    expect(screen.getByLabelText("工作目录")).toHaveValue("workspace/agents/新助手");
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "projects/research" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Agent" }));

    expect(await screen.findByText("新助手")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "新助手", cwd: "/data/projects/research" }),
    }));
  });

  it("首启进入空列表时自动打开创建 Agent 提示", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ agents: [] }), { status: 200 })));

    render(<AgentsPage onNavigate={vi.fn()} openCreateOnEmpty />);

    expect(await screen.findByText("请先创建 Agent 后再开始对话。")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent 名称")).toHaveFocus();
  });

  it("拖拽 Agent 后保存排序并更新列表", async () => {
    const agents = [
      { profile: { id: "first", name: "First", cwd: "/data/workspace/agents/first", status: "active", description: "" }, revision: "r1" },
      { profile: { id: "second", name: "Second", cwd: "/data/workspace/agents/second", status: "active", description: "" }, revision: "r2" },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/agents/order") {
        return new Response(JSON.stringify({ agents: [agents[1], agents[0]] }), { status: 200 });
      }
      return new Response(JSON.stringify({ agents }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentsPage onNavigate={vi.fn()} />);

    const first = await screen.findByRole("button", { name: "打开First；可拖动排序" });
    const second = screen.getByRole("button", { name: "打开Second；可拖动排序" });
    fireEvent.dragStart(second);
    fireEvent.dragOver(first);
    fireEvent.drop(first);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents/order", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ agentIds: ["second", "first"] }),
    })));
    expect(screen.getAllByRole("button", { name: /可拖动排序/u }).map((element) => element.textContent)).toEqual([
      expect.stringContaining("Second"),
      expect.stringContaining("First"),
    ]);
  });

  it("读取失败时不伪造默认 Agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network"))));

    render(<AgentsPage onNavigate={vi.fn()} />);

    expect(await screen.findByText("暂时无法刷新 Agent 列表。")).toBeInTheDocument();
    expect(screen.queryByText("默认 Agent")).not.toBeInTheDocument();
  });
});
