import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { AigcOutputsPage } from "./aigc-outputs-page";
import { AigcPublicDirectoryPage } from "./aigc-public-directory-page";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AIGC 产物页面", () => {
  it("使用服务端缩略图铺平展示图片，并按任务 ID 分页", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const page = new URL(url, "http://localhost").searchParams.get("page") ?? "1";
      return new Response(JSON.stringify({
        items: [{ id: `image-${page}`, taskId: `task-${page}`, name: `poster-${page}.png`, mediaType: "image/png", size: 2048, createdAt: "2026-08-18T00:00:01.000Z", interfaceName: "海报生成", taskCreatedAt: "2026-08-18T00:00:00.000Z", kind: "image" }],
        counts: { image: 25, video: 2, audio: 1, other: 3 },
        page: Number(page), pageSize: 24, total: 25, totalPages: 2,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage(<AigcOutputsPage />);

    expect(await screen.findByRole("img", { name: "poster-1.png" })).toHaveAttribute("src", "/api/v1/aigc/tasks/task-1/assets/image-1/thumbnail");
    expect(screen.getByRole("tab", { name: /图片25/u })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("img", { name: "poster-2.png" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("sort=desc&page=2&pageSize=24"))).toBe(true);
  });

  it("切换媒体分组并为音频提供内联播放", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const kind = new URL(String(input), "http://localhost").searchParams.get("kind");
      return new Response(JSON.stringify({
        items: kind === "audio" ? [{ id: "sound-1", taskId: "task-audio", name: "voice.wav", mediaType: "audio/wav", size: 1024, createdAt: "2026-08-18T00:00:01.000Z", interfaceName: "配音", taskCreatedAt: "2026-08-18T00:00:00.000Z", kind: "audio" }] : [],
        counts: { image: 0, video: 0, audio: 1, other: 0 }, page: 1, pageSize: 24, total: kind === "audio" ? 1 : 0, totalPages: kind === "audio" ? 1 : 0,
      }));
    }));
    renderPage(<AigcOutputsPage />);

    fireEvent.click(await screen.findByRole("tab", { name: /音频1/u }));
    expect(await screen.findByLabelText("播放 voice.wav")).toHaveAttribute("src", "/api/v1/aigc/tasks/task-audio/assets/sound-1");
  });
});

describe("AIGC 公开目录页面", () => {
  it("沿用文件浏览器并通过稳定公开链接预览和下载", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ entries: [{ path: "images/poster.png", name: "poster.png", kind: "file", mediaType: "image/png", size: 2048, modifiedAt: "2026-08-18T00:00:00.000Z", url: "https://files.example.test/aigc-public/files/stable-id" }] }))));
    renderPage(<AigcPublicDirectoryPage />);

    expect(await screen.findByRole("heading", { name: "公开目录" })).toBeInTheDocument();
    const download = screen.getByRole("link", { name: "下载" });
    expect(download).toHaveAttribute("href", "https://files.example.test/aigc-public/files/stable-id?download=1");
    fireEvent.click(screen.getByRole("button", { name: "预览 poster.png" }));
    expect(await screen.findByRole("img", { name: "poster.png" })).toHaveAttribute("src", "https://files.example.test/aigc-public/files/stable-id");
    await waitFor(() => expect(screen.getByLabelText("poster.png 预览")).toBeInTheDocument());
  });
});

function renderPage(page: ReactNode) {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}>{page}</ApiTaskProvider></ErrorToastProvider>);
}
