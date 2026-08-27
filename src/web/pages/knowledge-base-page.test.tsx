import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { KnowledgeBasePage, KNOWLEDGE_BASE_NAVIGATION_TOGGLE_EVENT } from "./knowledge-base-page";

function renderKnowledgeBasePage() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><KnowledgeBasePage /></ApiTaskProvider></ErrorToastProvider>);
}

describe("KnowledgeBasePage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("空知识库只展示创建入口，并可在应用内配置绑定 Agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/v1/knowledge-bases") return new Response(JSON.stringify({ knowledgeBases: [] }));
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [agent("agent-a", "写作助手"), agent("agent-b", "研究助手")] }));
      return new Response(JSON.stringify({ id: "base-a", name: "产品资料", description: "", agentIds: ["agent-a"], documents: [] }));
    }));

    renderKnowledgeBasePage();

    expect(await screen.findByRole("heading", { name: "知识库" })).toBeInTheDocument();
    expect(screen.getByAltText("BUG 守着空知识库")).toHaveAttribute(
      "src",
      "/brand/bugpaw/bugpaw-sleeping.png",
    );
    expect(screen.queryByRole("navigation", { name: "知识库列表" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建知识库" }));
    expect(await screen.findByRole("dialog", { name: "创建知识库" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "绑定 Agent 写作助手" })).toBeInTheDocument();
  });

});

function knowledgeBase(id: string, name: string) {
  return {
    id,
    name,
    description: "测试资料",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    agentIds: [],
    documents: [],
  };
}

function agent(id: string, name: string) {
  return { profile: { id, name, cwd: `/data/workspace/${id}`, avatar: { kind: "initial", value: name.slice(0, 1) }, instructions: {}, allowedTools: [], createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" }, revision: "r1" };
}
