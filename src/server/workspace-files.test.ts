// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "./agents/agent-store";
import { createDataPaths, type DataPaths } from "./paths";
import { createWorkspaceFileManager } from "./workspace-files";

describe("Agent 工作区文件管理", () => {
  const roots: string[] = [];
  let root: string;
  let paths: DataPaths;
  let agentId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-agent-workspace-files-"));
    roots.push(root);
    paths = await createDataPaths(root);
    const agent = await new AgentStore(paths).create({ name: "研究助手" });
    agentId = agent.profile.id;
    await mkdir(join(agent.profile.cwd, "docs"), { recursive: true });
    await writeFile(join(agent.profile.cwd, "readme.md"), "# Root", "utf8");
    await writeFile(join(agent.profile.cwd, "docs", "readme.txt"), "# Readme", "utf8");
    await writeFile(join(agent.profile.cwd, ".secret"), "private", "utf8");
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true })));
  });

  it("浏览、搜索、创建、移动和删除当前 Agent 的目录项", async () => {
    const manager = createWorkspaceFileManager(new AgentStore(paths));

    await expect(manager.list(agentId, "", false)).resolves.toMatchObject([
      { path: "docs", kind: "directory", name: "docs" },
      { path: "readme.md", kind: "file", mediaType: "text/markdown" },
    ]);
    await expect(manager.search(agentId, "read", false)).resolves.toEqual([
      expect.objectContaining({ path: "readme.md" }),
      expect.objectContaining({ path: "docs/readme.txt" }),
    ]);
    await expect(manager.createDirectory(agentId, "", "notes")).resolves.toMatchObject({ path: "notes", kind: "directory" });
    await expect(manager.rename(agentId, "notes", "archive")).resolves.toMatchObject({ path: "archive" });
    await expect(manager.move(agentId, "archive", "docs")).resolves.toMatchObject({ path: "docs/archive" });
    await expect(manager.remove(agentId, ["docs/readme.txt", "docs"])).resolves.toBeUndefined();
  });

  it("确认后创建缺失的嵌套目标目录并移动文件", async () => {
    const manager = createWorkspaceFileManager(new AgentStore(paths));

    await expect(manager.move(agentId, "readme.md", "drafts/review", true)).resolves.toMatchObject({
      path: "drafts/review/readme.md",
      kind: "file",
    });
    await expect(manager.readText(agentId, "drafts/review/readme.md")).resolves.toMatchObject({ content: "# Root" });
  });

  it("隐藏项默认不可见，并拒绝越界路径和符号链接", async () => {
    const manager = createWorkspaceFileManager(new AgentStore(paths));
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    const agent = await new AgentStore(paths).get(agentId);
    await symlink(outside, join(agent!.profile.cwd, "outside-link.txt"));

    await expect(manager.list(agentId, "", false)).resolves.not.toContainEqual(expect.objectContaining({ name: ".secret" }));
    await expect(manager.list(agentId, "", true)).resolves.toContainEqual(expect.objectContaining({ name: ".secret" }));
    await expect(manager.list(agentId, "../", false)).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(manager.readText(agentId, "outside-link.txt")).rejects.toMatchObject({ code: "UNSAFE_LINK" });
  });

  it("拒绝通过父目录符号链接读取、删除或移动工作区外文件", async () => {
    const manager = createWorkspaceFileManager(new AgentStore(paths));
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    const agent = await new AgentStore(paths).get(agentId);
    await symlink(outside, join(agent!.profile.cwd, "linked-directory"));

    await expect(manager.readText(agentId, "linked-directory/secret.txt")).rejects.toMatchObject({ code: "UNSAFE_LINK" });
    await expect(manager.readFile(agentId, "linked-directory/secret.txt", 1024)).rejects.toMatchObject({ code: "UNSAFE_LINK" });
    await expect(manager.remove(agentId, ["linked-directory/secret.txt"])).rejects.toMatchObject({ code: "UNSAFE_LINK" });
    await expect(manager.move(agentId, "linked-directory/secret.txt", "docs")).rejects.toMatchObject({ code: "UNSAFE_LINK" });
    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("secret");
  });

  it("上传流中途失败时清理当前半文件和本批已完成文件", async () => {
    const manager = createWorkspaceFileManager(new AgentStore(paths));
    const agent = await new AgentStore(paths).get(agentId);
    const broken = Readable.from((async function* () {
      yield Buffer.alloc(128 * 1024, 1);
      throw new Error("client disconnected");
    })());

    await expect(manager.saveUploads(agentId, "", [
      { filename: "complete.bin", mediaType: "application/octet-stream", stream: Readable.from(Buffer.from("ok")) },
      { filename: "partial.bin", mediaType: "application/octet-stream", stream: broken },
    ])).rejects.toThrow("client disconnected");

    expect(await readdir(agent!.profile.cwd)).not.toEqual(expect.arrayContaining(["complete.bin", "partial.bin"]));
  });

  it("引用目录包含普通隐藏文件但不会递归暴露 .pi", async () => {
    const manager = createWorkspaceFileManager(new AgentStore(paths));
    const agent = await new AgentStore(paths).get(agentId);
    await mkdir(join(agent!.profile.cwd, ".pi", "skills"), { recursive: true });
    await writeFile(join(agent!.profile.cwd, ".pi", "skills", "internal.md"), "private", "utf8");

    await expect(manager.listReferences(agentId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".secret", kind: "file" }),
      expect.objectContaining({ path: "docs", kind: "directory" }),
      expect.objectContaining({ path: "docs/readme.txt", kind: "file" }),
    ]));
    await expect(manager.listReferences(agentId)).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".pi" }),
      expect.objectContaining({ path: ".pi/skills/internal.md" }),
    ]));
  });

  it("只读取当前 Agent 工作区内且未超出大小限制的普通文件", async () => {
    const manager = createWorkspaceFileManager(new AgentStore(paths));
    const agent = await new AgentStore(paths).get(agentId);
    await writeFile(join(agent!.profile.cwd, "manual.pdf"), "PDF content", "utf8");
    await writeFile(join(agent!.profile.cwd, "large.md"), "1234", "utf8");

    await expect(manager.readFile(agentId, "manual.pdf", 20 * 1024 * 1024)).resolves.toMatchObject({
      name: "manual.pdf",
      mediaType: "application/pdf",
      content: Buffer.from("PDF content", "utf8"),
    });
    await expect(manager.readFile(agentId, "../secret.txt", 1024)).rejects.toThrow("文件路径无效");
    await expect(manager.readFile(agentId, "docs", 1024)).rejects.toThrow("目标路径不是文件");
    await expect(manager.readFile(agentId, "large.md", 3)).rejects.toThrow("资料不能超过");
  });

  it("文本预览只读取固定上限并标记截断", async () => {
    const manager = createWorkspaceFileManager(new AgentStore(paths));
    const agent = await new AgentStore(paths).get(agentId);
    await writeFile(join(agent!.profile.cwd, "huge.txt"), "中".repeat(300_000), "utf8");

    const preview = await manager.readText(agentId, "huge.txt");

    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.content, "utf8")).toBeLessThanOrEqual(512 * 1024);
  });

  it("递归扫描超过 20 层时返回稳定的工作量限制错误", async () => {
    const manager = createWorkspaceFileManager(new AgentStore(paths));
    const agent = await new AgentStore(paths).get(agentId);
    let directory = agent!.profile.cwd;
    for (let depth = 0; depth < 21; depth += 1) {
      directory = join(directory, `level-${depth}`);
      await mkdir(directory);
    }
    await writeFile(join(directory, "needle.txt"), "deep", "utf8");

    await expect(manager.search(agentId, "needle", true)).rejects.toMatchObject({ code: "WORKSPACE_SCAN_LIMIT" });
    await expect(manager.listReferences(agentId)).rejects.toMatchObject({ code: "WORKSPACE_SCAN_LIMIT" });
  });
});
