import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AigcMediaProject } from "../../shared/aigc-media-editor-contracts";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { AigcMediaEditorPage } from "./aigc-media-editor-page";

afterEach(() => vi.unstubAllGlobals());

describe("AigcMediaEditorPage", () => {
  it("切换已有视频与音频工程，并从标题打开旧工程", async () => {
    mockApi();
    renderPage(<AigcMediaEditorPage />);

    expect(await screen.findByRole("heading", { name: "轻剪辑" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "视频" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("画面与原音")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /视频工程/u }));
    const projectDialog = screen.getByRole("dialog", { name: "剪辑工程" });
    expect(projectDialog).toBeInTheDocument();
    const audioProject = projectDialog.querySelector(".aigc-media-editor-project-list button:nth-child(2)");
    expect(audioProject).toBeInTheDocument();

    fireEvent.click(audioProject as HTMLButtonElement);
    expect(screen.getByRole("tab", { name: "音频" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("连续音频")).toBeInTheDocument();
  });

  it("从真实产物列表添加视频片段并显示原音状态", async () => {
    const fetchMock = mockApi();
    renderPage(<AigcMediaEditorPage />);

    fireEvent.click(await screen.findByRole("button", { name: "添加产物" }));
    expect(await screen.findByRole("complementary", { name: "产物库" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /scene.mp4/u }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes("/media-projects/project-video") && init?.method === "PATCH")).toBe(true));
    expect(await screen.findByRole("checkbox", { name: "片段原音" })).toBeInTheDocument();
  });

  it("有片段时提交串行导出任务", async () => {
    const fetchMock = mockApi({ withClip: true });
    renderPage(<AigcMediaEditorPage />);

    fireEvent.click(await screen.findByRole("button", { name: "导出" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/render") && init?.method === "POST")).toBe(true));
    expect(await screen.findByText(/排队中/u)).toBeInTheDocument();
  });

  it("裁剪数值仅在编辑完成后保存", async () => {
    const fetchMock = mockApi({ withClip: true });
    renderPage(<AigcMediaEditorPage />);

    const startInput = await screen.findByRole("spinbutton", { name: /起点/u });
    fireEvent.change(startInput, { target: { value: "1" } });
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes("/media-projects/project-video") && init?.method === "PATCH")).toBe(false);
    fireEvent.blur(startInput);
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes("/media-projects/project-video") && init?.method === "PATCH")).toBe(true));
  });
});

function mockApi(options: { withClip?: boolean } = {}) {
  const video = project("project-video", "视频工程", "video", options.withClip ? [videoClip()] : []);
  const audio = project("project-audio", "音频工程", "audio", []);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/aigc/media-projects") && !url.endsWith("/render") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify({ projects: [video, audio] }));
    }
    if (url.includes("/api/v1/aigc/outputs")) {
      return new Response(JSON.stringify({
        items: [{ id: "asset-video", taskId: "task-video", name: "scene.mp4", mediaType: "video/mp4", size: 2048, createdAt: "2026-08-21T00:00:00.000Z", interfaceName: "视频生成", taskCreatedAt: "2026-08-21T00:00:00.000Z", kind: "video" }],
        counts: { image: 0, video: 1, audio: 0, other: 0 }, page: 1, pageSize: 96, total: 1, totalPages: 1,
      }));
    }
    if (init?.method === "PATCH" && url.includes("/media-projects/project-video")) {
      const body = JSON.parse(String(init.body)) as { name: string; clips: Array<{ id: string }> };
      return new Response(JSON.stringify(project("project-video", body.name, "video", body.clips.map(() => videoClip()))));
    }
    if (init?.method === "POST" && url.endsWith("/render")) {
      return new Response(JSON.stringify({ id: "render-1", projectId: "project-video", projectName: "视频工程", kind: "video", status: "queued", progress: 0, queuePosition: 1, createdAt: "2026-08-21T00:00:00.000Z" }), { status: 202 });
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function project(id: string, name: string, kind: "video" | "audio", clips: AigcMediaProject["clips"]): AigcMediaProject {
  return { id, revision: "revision-1", name, kind, clips, createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" };
}

function videoClip(): AigcMediaProject["clips"][number] {
  return { id: "clip-video", source: { taskId: "task-video", assetId: "asset-video" }, name: "scene.mp4", mediaType: "video/mp4", kind: "video", sourceDurationMs: 5000, trimStartMs: 0, trimEndMs: 5000, hasAudio: true, muted: false };
}

function renderPage(page: ReactNode) {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}>{page}</ApiTaskProvider></ErrorToastProvider>);
}
