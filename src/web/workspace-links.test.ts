import { describe, expect, it, vi } from "vitest";

import type { WorkspaceEntry } from "../shared/contracts";
import { ApiClientError } from "./api";
import { classifyWorkspaceLink, locateWorkspaceReference } from "./workspace-links";

describe("工作目录 Markdown 链接", () => {
  it("只把安全相对路径识别为工作目录引用", () => {
    expect(classifyWorkspaceLink("https://example.com/a")).toEqual({ kind: "passthrough" });
    expect(classifyWorkspaceLink("mailto:admin@example.com")).toEqual({ kind: "passthrough" });
    expect(classifyWorkspaceLink("/settings")).toEqual({ kind: "passthrough" });
    expect(classifyWorkspaceLink("#part")).toEqual({ kind: "passthrough" });
    expect(classifyWorkspaceLink("docs/a%20b.md?raw=1#L2")).toEqual({ kind: "workspace", path: "docs/a b.md" });
    expect(classifyWorkspaceLink("./docs/a.md")).toEqual({ kind: "workspace", path: "docs/a.md" });
    expect(classifyWorkspaceLink("../secret.txt")).toMatchObject({ kind: "blocked" });
    expect(classifyWorkspaceLink("file:///etc/passwd")).toMatchObject({ kind: "blocked" });
    expect(classifyWorkspaceLink("C:\\Users\\a.txt")).toMatchObject({ kind: "blocked" });
    expect(classifyWorkspaceLink("docs/%E0%A4%A.md")).toMatchObject({ kind: "blocked" });
  });

  it("定位现有目录", async () => {
    const listDirectory = vi.fn(async (directory: string) => directory === "docs"
      ? [file("docs/readme.md", "readme.md")]
      : notFound());

    await expect(locateWorkspaceReference("docs", listDirectory)).resolves.toEqual({
      kind: "directory",
      directory: "docs",
    });
  });

  it("通过父目录定位现有文件", async () => {
    const target = file("docs/readme.md", "readme.md");
    const listDirectory = vi.fn(async (directory: string) => {
      if (directory === "docs/readme.md") return notFound();
      if (directory === "docs") return [target];
      return notFound();
    });

    await expect(locateWorkspaceReference("docs/readme.md", listDirectory)).resolves.toEqual({
      kind: "file",
      directory: "docs",
      entry: target,
    });
  });

  it("失效目标回退到最深可访问父目录", async () => {
    const listDirectory = vi.fn(async (directory: string) => {
      if (directory === "docs") return [directoryEntry("docs/archive", "archive")];
      if (directory === "") return [directoryEntry("docs", "docs")];
      return notFound();
    });

    await expect(locateWorkspaceReference("docs/missing/deep.md", listDirectory)).resolves.toEqual({
      kind: "missing",
      directory: "docs",
      path: "docs/missing/deep.md",
    });
  });

  it("不会把服务异常伪装成文件失效", async () => {
    const failure = new ApiClientError("REQUEST_FAILED", "服务不可用", 503);
    const listDirectory = vi.fn(async () => { throw failure; });

    await expect(locateWorkspaceReference("docs/readme.md", listDirectory)).rejects.toBe(failure);
  });
});

function file(path: string, name: string): WorkspaceEntry {
  return { path, name, kind: "file", mediaType: "text/markdown", size: 8, modifiedAt: "2026-08-12T00:00:00.000Z" };
}

function directoryEntry(path: string, name: string): WorkspaceEntry {
  return { path, name, kind: "directory", modifiedAt: "2026-08-12T00:00:00.000Z" };
}

function notFound(): never {
  throw new ApiClientError("NOT_FOUND", "不存在", 404);
}
