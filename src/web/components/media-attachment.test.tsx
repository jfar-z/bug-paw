import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { WorkspaceFileSummary } from "../../shared/contracts";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { MediaAttachment } from "./media-attachment";

function renderMediaAttachment(element: ReactElement) {
  const wrap = (child: ReactElement) => <ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}>{child}</ApiTaskProvider></ErrorToastProvider>;
  const result = render(wrap(element));
  return { ...result, rerender: (next: ReactElement) => result.rerender(wrap(next)) };
}

function workspaceFile(mediaType: string, name = "产物.bin"): WorkspaceFileSummary {
  return {
    path: `attachments/${name}`,
    name,
    mediaType,
    size: 2048,
    modifiedAt: "2026-08-05T08:00:00.000Z",
  };
}

describe("MediaAttachment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("按媒体类型展示图片、音频和视频", () => {
    const { rerender } = renderMediaAttachment(<MediaAttachment file={workspaceFile("image/png", "图片.png")} />);
    expect(screen.getByRole("img", { name: "图片.png" })).toHaveAttribute("src", "/api/v1/agents/default/files/attachments/%E5%9B%BE%E7%89%87.png");

    rerender(<MediaAttachment file={workspaceFile("audio/mpeg", "声音.mp3")} />);
    expect(document.querySelector("audio")).toHaveAttribute("controls");

    rerender(<MediaAttachment file={workspaceFile("video/mp4", "视频.mp4")} />);
    expect(document.querySelector("video")).toHaveAttribute("controls");
  });

  it("图片提供全屏预览入口，视频只保留原生控制条", () => {
    const onPreview = vi.fn();
    const { rerender } = renderMediaAttachment(<MediaAttachment file={workspaceFile("image/png", "图片.png")} onPreview={onPreview} />);

    fireEvent.click(screen.getByRole("button", { name: "全屏预览 图片.png" }));
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ name: "图片.png", mediaType: "image/png" }));

    rerender(<MediaAttachment file={workspaceFile("video/mp4", "视频.mp4")} onPreview={onPreview} />);
    expect(document.querySelector("video")).toHaveAttribute("controls");
    expect(screen.queryByRole("button", { name: "全屏预览 视频.mp4" })).not.toBeInTheDocument();
  });

  it("普通文件展示大小且所有类型都有快捷下载", () => {
    renderMediaAttachment(<MediaAttachment file={workspaceFile("application/pdf", "报告.pdf")} />);

    expect(screen.getByText("报告.pdf")).toBeInTheDocument();
    expect(screen.getByText("attachments/报告.pdf")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 报告.pdf" })).toHaveAttribute(
      "href",
      "/api/v1/agents/default/files/attachments/%E6%8A%A5%E5%91%8A.pdf?download=1",
    );
  });

  it("仅有相对路径时通过 HEAD 加载文件元数据", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": "12",
        "Last-Modified": "Wed, 05 Aug 2026 08:00:00 GMT",
      },
    })));

    renderMediaAttachment(<MediaAttachment file={{ path: "attachments/agent-output.png" }} />);

    expect(await screen.findByRole("img", { name: "agent-output.png" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/agents/default/files/attachments/agent-output.png",
      expect.objectContaining({ method: "HEAD" }),
    );
  });
});
