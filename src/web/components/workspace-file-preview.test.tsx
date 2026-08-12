import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceEntry } from "../../shared/contracts";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { WorkspaceFilePreview } from "./workspace-file-preview";

describe("WorkspaceFilePreview", () => {
  it("将 HTML 作为受限页面预览，并允许切换到源码", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ path: "site/index.html", content: "<h1>页面</h1>", truncated: false }))));
    renderPreview("side", htmlEntry());

    const frame = screen.getByTitle("index.html 页面预览");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("src", "/api/v1/agents/agent-a/files/site/index.html");
    expect(new URL("./assets/site.css", new URL(frame.getAttribute("src")!, "http://localhost")).pathname).toBe("/api/v1/agents/agent-a/files/site/assets/site.css");

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await screen.findByText("<h1>页面</h1>")).toBeInTheDocument();
  });

  it("通过 Fullscreen API 在全屏与普通预览间切换", () => {
    const requestFullscreen = vi.fn(async () => undefined);
    const exitFullscreen = vi.fn(async () => undefined);
    const requestFullscreenDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "requestFullscreen");
    const fullscreenElementDescriptor = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    const exitFullscreenDescriptor = Object.getOwnPropertyDescriptor(document, "exitFullscreen");
    let fullscreenElement: Element | null = null;
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: requestFullscreen });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });

    try {
      renderPreview("side");
      fireEvent.click(screen.getByRole("button", { name: "全屏预览" }));
      expect(requestFullscreen).toHaveBeenCalledOnce();

      fullscreenElement = screen.getByLabelText("demo.png 预览");
      fireEvent(document, new Event("fullscreenchange"));
      fireEvent.click(screen.getByRole("button", { name: "退出全屏预览" }));
      expect(exitFullscreen).toHaveBeenCalledOnce();
    } finally {
      restoreDescriptor(HTMLElement.prototype, "requestFullscreen", requestFullscreenDescriptor);
      restoreDescriptor(document, "fullscreenElement", fullscreenElementDescriptor);
      restoreDescriptor(document, "exitFullscreen", exitFullscreenDescriptor);
    }
  });

  it("按容器职责渲染侧栏或覆盖式预览", () => {
    const side = renderPreview("side");
    expect(side.container.querySelector(".workspace-file-preview--side")).toBeInTheDocument();
    side.unmount();

    const overlay = renderPreview("overlay");
    expect(overlay.container.querySelector(".workspace-file-preview--overlay")).toBeInTheDocument();
    expect(overlay.container.querySelector(".workspace-file-preview--overlay")).toHaveStyle({ width: "100%", minWidth: 0, height: "100%", touchAction: "pan-y" });
    expect(overlay.container.querySelector(".workspace-file-preview__body")).toHaveStyle({ touchAction: "pan-y" });
    expect(screen.getByRole("button", { name: "返回文件列表" })).toBeInTheDocument();
  });
});

function renderPreview(mode: "side" | "overlay", entry: WorkspaceEntry = imageEntry()) {
  return render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={vi.fn()}>
        <WorkspaceFilePreview agentId="agent-a" entry={entry} mode={mode} onClose={vi.fn()} />
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
}

function imageEntry(): WorkspaceEntry {
  return {
    path: "images/demo.png",
    name: "demo.png",
    kind: "file",
    mediaType: "image/png",
    size: 16,
    modifiedAt: "2026-08-12T00:00:00.000Z",
  };
}

function htmlEntry(): WorkspaceEntry {
  return {
    path: "site/index.html",
    name: "index.html",
    kind: "file",
    mediaType: "text/html",
    size: 16,
    modifiedAt: "2026-08-12T00:00:00.000Z",
  };
}

function restoreDescriptor(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete (target as Record<string, unknown>)[key];
}
