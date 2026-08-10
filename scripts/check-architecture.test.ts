// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkArchitecture } from "./check-architecture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("架构边界检查", () => {
  it("拒绝 Web 导入 Server、Shared 导入 Node 和数据库层外直接执行 SQL", async () => {
    const root = await fixture({
      "src/web/bad.ts": 'import { x } from "../server/main";\nexport { x };',
      "src/shared/bad.ts": 'import { readFile } from "node:fs";\nexport { readFile };',
      "src/server/services/bad.ts": 'export const bad = (db: any) => db.prepare("SELECT 1");',
    });

    expect(checkArchitecture(root).map(({ rule }) => rule).sort()).toEqual([
      "SHARED_PORTABILITY",
      "SQL_OWNERSHIP",
      "WEB_SERVER_BOUNDARY",
    ]);
  });

  it("拒绝页面绕过统一 API Client 和重新引入旧 JSON 状态文件", async () => {
    const root = await fixture({
      "src/web/pages/bad.ts": 'export const load = () => fetch("/api/v1/status");',
      "src/server/services/legacy.ts": 'export const stateFile = "session-metadata.json";',
    });

    expect(checkArchitecture(root).map(({ rule }) => rule).sort()).toEqual([
      "LEGACY_STATE_OWNERSHIP",
      "WEB_API_CLIENT_BOUNDARY",
    ]);
  });

  it("拒绝 Route 绕过统一错误出口", async () => {
    const root = await fixture({
      "src/server/routes/bad.ts": 'export const bad = (reply: any) => reply.send({ error: { code: "ANY" } });',
    });

    expect(checkArchitecture(root).map(({ rule }) => rule)).toEqual(["API_ERROR_BOUNDARY"]);
  });

  it("允许 Web 导入 Shared、Repository 使用数据库包装器", async () => {
    const root = await fixture({
      "src/web/good.ts": 'import type { Contract } from "../shared/good";\nexport type Value = Contract;',
      "src/shared/good.ts": "export interface Contract { id: string }",
      "src/server/database/repository.ts": 'export const read = (db: any) => db.prepare("SELECT 1");',
    });

    expect(checkArchitecture(root)).toEqual([]);
  });
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-architecture-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return root;
}
