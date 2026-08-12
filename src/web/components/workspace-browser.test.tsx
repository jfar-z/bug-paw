import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceEntry } from "../../shared/contracts";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { WorkspaceBrowser } from "./workspace-browser";

afterEach(() => vi.unstubAllGlobals());

describe("WorkspaceBrowser", () => {
  it("固定 Agent 浏览资源且点击目录信息区整行进入", async () => {
    const fetchMock = workspaceFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderBrowser();

    const directoryButton = await screen.findByRole("button", { name: "进入 docs" });
    const row = directoryButton.closest("tr")!;
    fireEvent.click(row.cells[2]);

    await waitFor(() => expect(requestedDirectory(fetchMock, "docs")).toBe(true));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/v1/agents")).toBe(false);
  });

  it("目录复选框和操作列不会触发进入目录", async () => {
    const fetchMock = workspaceFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderBrowser();

    const checkbox = await screen.findByRole("checkbox", { name: "选择 docs" });
    const row = checkbox.closest("tr")!;
    fireEvent.click(checkbox);
    fireEvent.click(row.querySelector(".workspace-entry-actions-cell")!);

    expect(requestedDirectory(fetchMock, "docs")).toBe(false);
    expect(checkbox).toBeChecked();
  });

  it("引用文件时进入父目录、高亮目标并使用覆盖式预览", async () => {
    vi.stubGlobal("fetch", workspaceFetch());
    const { container } = renderBrowser({ mode: "quick", locationRequest: { id: 1, path: "docs/readme.md" } });

    expect(await screen.findByLabelText("readme.md 预览")).toHaveClass("workspace-file-preview--overlay");
    expect(container.querySelector("tr.is-reference-target")).toHaveTextContent("readme.md");
    expect(screen.queryByText("搜索当前 Agent 的全部文件")).not.toBeInTheDocument();
  });
});

function renderBrowser(props: Partial<Parameters<typeof WorkspaceBrowser>[0]> = {}) {
  return render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={vi.fn()}>
        <WorkspaceBrowser agentId="agent-a" mode="page" {...props} />
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
}

function workspaceFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("directory=docs%2Freadme.md")) {
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "目录不存在" } }), { status: 404 });
    }
    if (url.includes("directory=docs")) {
      return new Response(JSON.stringify({ entries: [file("docs/readme.md", "readme.md")] }));
    }
    return new Response(JSON.stringify({ entries: [directory("docs"), file("readme.md", "readme.md")] }));
  });
}

function requestedDirectory(fetchMock: ReturnType<typeof workspaceFetch>, directory: string): boolean {
  return fetchMock.mock.calls.some(([input]) => String(input).includes(`directory=${encodeURIComponent(directory)}`));
}

function file(path: string, name: string): WorkspaceEntry {
  return { path, name, kind: "file", mediaType: "image/png", size: 8, modifiedAt: "2026-08-12T00:00:00.000Z" };
}

function directory(name: string): WorkspaceEntry {
  return { path: name, name, kind: "directory", modifiedAt: "2026-08-12T00:00:00.000Z" };
}
