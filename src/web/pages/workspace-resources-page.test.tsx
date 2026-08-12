import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { WorkspaceResourcesPage } from "./workspace-resources-page";

function renderWorkspaceResourcesPage() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><WorkspaceResourcesPage /></ApiTaskProvider></ErrorToastProvider>);
}

describe("WorkspaceResourcesPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("浏览当前 Agent 文件、搜索并预览文本", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [agent("agent-a", "写作助手"), agent("agent-b", "研究助手")] }));
      if (url.includes("/workspace/text")) return new Response(JSON.stringify({ path: "docs/readme.md", content: "# Readme", truncated: false }));
      if (url.includes("/workspace/search")) return new Response(JSON.stringify({ entries: [entry("docs/readme.md", "readme.md")] }));
      return new Response(JSON.stringify({ entries: [directory("docs"), entry("readme.md", "readme.md")] }));
    }));

    renderWorkspaceResourcesPage();
    expect(await screen.findByRole("heading", { name: "资源管理" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择 Agent 研究助手" }));
    fireEvent.change(screen.getByLabelText("搜索文件名"), { target: { value: "readme" } });
    expect(await screen.findByText("docs/readme.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预览 readme.md" }));
    expect(await screen.findByText("# Readme")).toBeInTheDocument();
  });

  it("按常见文件后缀显示对应图标，未知后缀回退为文件图标", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/agents") return new Response(JSON.stringify({ agents: [agent("agent-a", "写作助手")] }));
      return new Response(JSON.stringify({ entries: [
        entry("cover.JPG", "cover.JPG"),
        entry("podcast.flac", "podcast.flac"),
        entry("demo.webm", "demo.webm"),
        entry("proposal.pdf", "proposal.pdf"),
        entry("archive.bin", "archive.bin"),
      ] }));
    }));

    const { container } = renderWorkspaceResourcesPage();

    await screen.findAllByText("cover.JPG");
    expect(container.querySelector(".lucide-file-image")).toBeInTheDocument();
    expect(container.querySelector(".lucide-file-headphone")).toBeInTheDocument();
    expect(container.querySelector(".lucide-file-play")).toBeInTheDocument();
    expect(container.querySelector(".lucide-file-text")).toBeInTheDocument();
    expect(container.querySelectorAll(".lucide-file")).toHaveLength(1);
  });

  it("没有工作空间时让 BUG 在资源管理中等候", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }));
      return new Response(JSON.stringify({ entries: [] }));
    }));

    renderWorkspaceResourcesPage();

    const emptyMascot = await screen.findByAltText("BUG 正在等候第一个工作空间");
    expect(emptyMascot).toHaveAttribute("src", "/brand/bugpaw/bugpaw-sleeping.png");
    expect(screen.getByText("请先在配置中心创建 Agent。")).toBeInTheDocument();
  });

  it("批量删除需明确二次确认", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [agent("agent-a", "写作助手")] }));
      return new Response(JSON.stringify({ entries: [entry("readme.md", "readme.md")] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWorkspaceResourcesPage();
    await screen.findByRole("checkbox", { name: "选择 readme.md" });
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 readme.md" }));
    fireEvent.click(screen.getByRole("button", { name: "删除所选 1 项" }));
    expect(screen.getByText("1 个项目将被永久删除，无法恢复。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/workspace/entries"), expect.objectContaining({ method: "DELETE" }));
  });

  it("在应用内对话框中填写文件移动目录", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [agent("agent-a", "写作助手")] }));
      if (init?.method === "PATCH") return new Response(JSON.stringify(entry("docs/readme.md", "readme.md")));
      return new Response(JSON.stringify({ entries: [entry("readme.md", "readme.md")] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const promptSpy = vi.spyOn(window, "prompt");

    renderWorkspaceResourcesPage();
    expect(await screen.findByRole("button", { name: "移动 readme.md" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移动 readme.md" }));
    expect(screen.getByRole("dialog", { name: "移动文件" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("目标目录"), { target: { value: "docs" } });
    fireEvent.click(screen.getByRole("button", { name: "确认移动" }));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/workspace/entries"), expect.objectContaining({ method: "PATCH", body: JSON.stringify({ operation: "move", path: "readme.md", targetDirectory: "docs" }) }));
  });

  it("目录不存在时允许确认创建并移动文件", async () => {
    let moveAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [agent("agent-a", "写作助手")] }));
      if (init?.method === "PATCH") {
        moveAttempts += 1;
        if (moveAttempts === 1) {
          return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "文件或目录不存在" } }), { status: 404 });
        }
        return new Response(JSON.stringify(entry("drafts/review/readme.md", "readme.md")));
      }
      return new Response(JSON.stringify({ entries: [entry("readme.md", "readme.md")] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWorkspaceResourcesPage();
    fireEvent.click(await screen.findByRole("button", { name: "移动 readme.md" }));
    fireEvent.change(screen.getByLabelText("目标目录"), { target: { value: "drafts/review" } });
    fireEvent.click(screen.getByRole("button", { name: "确认移动" }));

    expect(await screen.findByText("目录“drafts/review”不存在。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建并移动" }));
    await waitFor(() => expect(moveAttempts).toBe(2));
    const moveRequests = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(moveRequests[1]?.[1]).toMatchObject({
      body: JSON.stringify({ operation: "move", path: "readme.md", targetDirectory: "drafts/review", createTargetDirectory: true }),
    });
  });

  it("在应用内对话框中重命名文件并新建文件夹", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [agent("agent-a", "写作助手")] }));
      if (init?.method === "PATCH") return new Response(JSON.stringify(entry("renamed.md", "renamed.md")));
      if (url.includes("/workspace/directories")) return new Response(JSON.stringify(directory("drafts")));
      return new Response(JSON.stringify({ entries: [entry("readme.md", "readme.md")] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const promptSpy = vi.spyOn(window, "prompt");

    renderWorkspaceResourcesPage();
    expect(await screen.findByRole("button", { name: "重命名 readme.md" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重命名 readme.md" }));
    expect(screen.getByRole("dialog", { name: "重命名文件" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("新名称"), { target: { value: "renamed.md" } });
    fireEvent.click(screen.getByRole("button", { name: "确认重命名" }));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/workspace/entries"), expect.objectContaining({ method: "PATCH", body: JSON.stringify({ operation: "rename", path: "readme.md", name: "renamed.md" }) }));

    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    expect(screen.getByRole("dialog", { name: "新建文件夹" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("文件夹名称"), { target: { value: "drafts" } });
    fireEvent.click(screen.getByRole("button", { name: "确认新建" }));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/workspace/directories"), expect.objectContaining({ method: "POST", body: JSON.stringify({ directory: "", name: "drafts" }) }));
  });

  it("长文件名仍保留选择框和行操作区域", async () => {
    const longName = "这是一个很长很长很长很长很长很长很长的文件名.md";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/agents") return new Response(JSON.stringify({ agents: [agent("agent-a", "写作助手")] }));
      return new Response(JSON.stringify({ entries: [entry(longName, longName)] }));
    }));

    renderWorkspaceResourcesPage();
    expect((await screen.findByRole("checkbox", { name: `选择 ${longName}` })).parentElement).toHaveClass("workspace-entry-select");
    const actionCell = screen.getByRole("button", { name: `移动 ${longName}` }).closest("td");
    expect(actionCell).toHaveStyle({ position: "sticky", right: "0px" });
    expect(screen.getByRole("columnheader", { name: "操作" })).toHaveStyle({ position: "sticky", right: "0px" });
    expect(document.querySelector(".workspace-entry-name__label")).toHaveTextContent(longName);
  });
});

function agent(id: string, name: string) {
  return { profile: { id, name, cwd: `/data/workspace/${id}`, avatar: { kind: "initial", value: name.slice(0, 1) }, instructions: {}, allowedTools: [], createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" }, revision: "r1" };
}

function entry(path: string, name: string) {
  return { path, name, kind: "file", mediaType: "text/markdown", size: 8, modifiedAt: "2026-08-06T00:00:00.000Z" };
}

function directory(name: string) {
  return { path: name, name, kind: "directory", modifiedAt: "2026-08-06T00:00:00.000Z" };
}
