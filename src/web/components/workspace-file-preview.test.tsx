import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceEntry } from "../../shared/contracts";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { WorkspaceFilePreview } from "./workspace-file-preview";

describe("WorkspaceFilePreview", () => {
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

function renderPreview(mode: "side" | "overlay") {
  const entry: WorkspaceEntry = {
    path: "images/demo.png",
    name: "demo.png",
    kind: "file",
    mediaType: "image/png",
    size: 16,
    modifiedAt: "2026-08-12T00:00:00.000Z",
  };
  return render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={vi.fn()}>
        <WorkspaceFilePreview agentId="agent-a" entry={entry} mode={mode} onClose={vi.fn()} />
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
}
