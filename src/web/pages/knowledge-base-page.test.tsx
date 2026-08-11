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

  it("创建响应未附带空集合时仍可展示新知识库", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/knowledge-bases" && init?.method !== "POST") return new Response(JSON.stringify({ knowledgeBases: [] }));
      if (url === "/api/v1/knowledge-bases") return new Response(JSON.stringify({ id: "base-a", name: "产品资料", description: "", createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z" }));
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }));
      return new Response(JSON.stringify({}));
    }));

    renderKnowledgeBasePage();

    fireEvent.click(await screen.findByRole("button", { name: "创建知识库" }));
    fireEvent.change(screen.getByRole("textbox", { name: "知识库名称" }), { target: { value: "产品资料" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "创建知识库" })).getByRole("button", { name: "创建知识库" }));
    expect(await screen.findByRole("heading", { name: "产品资料" })).toBeInTheDocument();
    expect(screen.getByText("0 份资料")).toBeInTheDocument();
  });

  it("以知识库列表作为二级菜单，并展示已选知识库的资料区", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/v1/knowledge-bases") return new Response(JSON.stringify({ knowledgeBases: [{ id: "base-a", name: "产品资料", description: "测试资料", agentIds: ["agent-a"], documents: [{ id: "doc-a", name: "说明.txt", mediaType: "text/plain", status: "indexed", createdAt: "2026-08-07T00:00:00.000Z" }] }] }));
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [agent("agent-a", "写作助手")] }));
      return new Response(JSON.stringify({}));
    }));

    renderKnowledgeBasePage();

    expect(await screen.findByRole("navigation", { name: "知识库列表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择知识库 产品资料" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传资料" })).toBeInTheDocument();
    expect(screen.getByText("说明.txt")).toBeInTheDocument();
    expect(screen.getByText("语义优先")).toBeInTheDocument();
    expect(screen.getByText("未启用或未命中时全文回退")).toBeInTheDocument();
    expect(screen.getByText("使用本地 LanceDB 全文与向量索引。语义检索可在配置中心启用或关闭。")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event(KNOWLEDGE_BASE_NAVIGATION_TOGGLE_EVENT));
    });
    expect(screen.getByLabelText("关闭知识库列表")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择知识库 产品资料" }));
    expect(screen.queryByLabelText("关闭知识库列表")).not.toBeInTheDocument();
  });

  it("可编辑知识库、预览 Markdown 原文并在确认后删除资料", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/knowledge-bases" && !init?.method) return new Response(JSON.stringify({ knowledgeBases: [{ id: "base-a", name: "产品资料", description: "测试资料", agentIds: [], documents: [{ id: "doc-a", knowledgeBaseId: "base-a", name: "说明.md", mediaType: "text/markdown", status: "indexed", createdAt: "2026-08-07T00:00:00.000Z" }] }] }));
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }));
      if (url === "/api/v1/knowledge-bases/base-a" && init?.method === "PATCH") return new Response(JSON.stringify({ id: "base-a", name: "更新资料", description: "更新说明", agentIds: [], documents: [{ id: "doc-a", knowledgeBaseId: "base-a", name: "说明.md", mediaType: "text/markdown", status: "indexed", createdAt: "2026-08-07T00:00:00.000Z" }] }));
      if (url === "/api/v1/knowledge-bases/base-a/documents/doc-a/chunks") return new Response(JSON.stringify({ chunks: [
        { chunkId: "doc-a:0", documentId: "doc-a", index: 0, text: "# 第一段", page: 1 },
        { chunkId: "doc-a:1", documentId: "doc-a", index: 1, text: "第二段", page: 2 },
      ] }));
      if (url === "/api/v1/knowledge-bases/base-a/documents/doc-a") {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ id: "doc-a", knowledgeBaseId: "base-a", name: "说明.md", mediaType: "text/markdown", status: "indexed", createdAt: "2026-08-07T00:00:00.000Z", text: "# 原始 Markdown" }));
      }
      if (url === "/api/v1/knowledge-bases/base-a") return new Response(JSON.stringify({ id: "base-a", name: "更新资料", description: "更新说明", agentIds: [], documents: [] }));
      return new Response(JSON.stringify({}));
    }));

    renderKnowledgeBasePage();

    fireEvent.click(await screen.findByRole("button", { name: "编辑知识库" }));
    fireEvent.change(screen.getByRole("textbox", { name: "知识库名称" }), { target: { value: "更新资料" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("heading", { name: "更新资料" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看资料 说明.md" }));
    expect(await screen.findByRole("heading", { name: "原始 Markdown" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "原始文本" }));
    expect(screen.getByText("# 原始 Markdown", { selector: "pre" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "分片内容" }));
    expect(await screen.findByText("切片 1")).toBeInTheDocument();
    expect(screen.getByText("# 第一段", { selector: "pre" })).toBeInTheDocument();
    expect(screen.getByText("第 2 页")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开原文件" })).toHaveAttribute("href", "/api/v1/knowledge-bases/base-a/documents/doc-a/source");
    fireEvent.click(screen.getByRole("button", { name: "关闭资料详情" }));

    fireEvent.click(screen.getByRole("button", { name: "删除资料 说明.md" }));
    expect(screen.getByRole("dialog", { name: "删除资料" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除资料" }));
    expect(await screen.findByText("尚无资料。上传 TXT、Markdown、PDF 或 DOCX 后即可检索。")).toBeInTheDocument();
  });

  it("输入完整名称后删除知识库，并选择原位置的下一项", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/knowledge-bases" && !init?.method) {
        return new Response(JSON.stringify({ knowledgeBases: [
          knowledgeBase("base-a", "产品资料"),
          knowledgeBase("base-b", "团队手册"),
        ] }));
      }
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }));
      if (url === "/api/v1/knowledge-bases/base-a" && init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderKnowledgeBasePage();

    fireEvent.click(await screen.findByRole("button", { name: "编辑知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "删除知识库" }));
    expect(await screen.findByRole("dialog", { name: "永久删除知识库" })).toBeInTheDocument();
    const confirmButton = screen.getByRole("button", { name: "永久删除知识库" });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "输入知识库名称以确认" }), { target: { value: "产品资料" } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    expect(await screen.findByRole("heading", { name: "团队手册" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择知识库 产品资料" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/knowledge-bases/base-a", expect.objectContaining({ method: "DELETE" }));
  });

  it("删除最后一个知识库后展示空状态", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/knowledge-bases" && !init?.method) return new Response(JSON.stringify({ knowledgeBases: [knowledgeBase("base-a", "产品资料")] }));
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }));
      if (url === "/api/v1/knowledge-bases/base-a" && init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({}));
    }));

    renderKnowledgeBasePage();

    fireEvent.click(await screen.findByRole("button", { name: "编辑知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "删除知识库" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "输入知识库名称以确认" }), { target: { value: "产品资料" } });
    fireEvent.click(screen.getByRole("button", { name: "永久删除知识库" }));

    expect(await screen.findByRole("heading", { name: "知识库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建知识库" })).toBeInTheDocument();
  });

  it("知识库删除发生意外错误时保留确认输入并显示 Toast", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/knowledge-bases" && !init?.method) return new Response(JSON.stringify({ knowledgeBases: [knowledgeBase("base-a", "产品资料")] }));
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }));
      if (url === "/api/v1/knowledge-bases/base-a" && init?.method === "DELETE") {
        return new Response(JSON.stringify({ error: { code: "DELETE_FAILED", message: "删除知识库失败" } }), { status: 500 });
      }
      return new Response(JSON.stringify({}));
    }));

    renderKnowledgeBasePage();

    fireEvent.click(await screen.findByRole("button", { name: "编辑知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "删除知识库" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "输入知识库名称以确认" }), { target: { value: "产品资料" } });
    fireEvent.click(screen.getByRole("button", { name: "永久删除知识库" }));

    expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "永久删除知识库" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "输入知识库名称以确认" })).toHaveValue("产品资料");
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
