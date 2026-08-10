// @vitest-environment node

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAgentWorkspace } from "./agent-workspace";

describe("Agent 工作目录解析", () => {
  const roots: string[] = [];
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-agent-workspace-"));
    roots.push(root);
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("拒绝相对路径、数据根目录和越界绝对路径", async () => {
    await expect(resolveAgentWorkspace(root, "relative/path"))
      .rejects.toMatchObject({ code: "WORKSPACE_NOT_ABSOLUTE" });
    await expect(resolveAgentWorkspace(root, root))
      .rejects.toMatchObject({ code: "WORKSPACE_ROOT_FORBIDDEN" });
    await expect(resolveAgentWorkspace(root, join(root, "..", "escape")))
      .rejects.toMatchObject({ code: "WORKSPACE_OUTSIDE_DATA" });
  });

  it("拒绝通过已有符号链接越出数据目录", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pi-agent-outside-"));
    roots.push(outside);
    await symlink(outside, join(root, "linked-outside"), "dir");

    await expect(resolveAgentWorkspace(root, join(root, "linked-outside", "project")))
      .rejects.toMatchObject({ code: "WORKSPACE_OUTSIDE_DATA" });
  });

  it("返回已有目录或待创建目录的规范真实路径", async () => {
    const existing = join(root, "projects", "demo");
    await mkdir(existing, { recursive: true });

    await expect(resolveAgentWorkspace(root, `${existing}/../demo`)).resolves.toBe(existing);
    await expect(resolveAgentWorkspace(root, join(root, "projects", "new-project")))
      .resolves.toBe(join(root, "projects", "new-project"));
  });

  it("拒绝把文件作为工作目录或父目录", async () => {
    const file = join(root, "not-a-directory");
    await writeFile(file, "file", "utf8");

    await expect(resolveAgentWorkspace(root, file))
      .rejects.toMatchObject({ code: "WORKSPACE_NOT_DIRECTORY" });
    await expect(resolveAgentWorkspace(root, join(file, "child")))
      .rejects.toMatchObject({ code: "WORKSPACE_NOT_DIRECTORY" });
  });
});
