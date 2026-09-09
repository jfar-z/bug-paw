import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkArchitecture } from "./check-architecture";

/** 异常可观测门禁禁止模糊文案和页面静默吞错。 */
describe("checkArchitecture 异常可观测性", () => {
  it("报告模糊兜底文案", async () => {
    const root = await fixture("server/example.ts", 'throw new Error("请求失败");');
    expect(checkArchitecture(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "GENERIC_ERROR_FALLBACK" }),
    ]));
  });

  it("报告页面中的静默 Promise catch", async () => {
    const root = await fixture("web/pages/example.tsx", "void load().catch(() => undefined);");
    expect(checkArchitecture(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "WEB_SILENT_ERROR" }),
    ]));
  });
});

/** 创建最小源码树供架构检查测试。 */
async function fixture(path: string, content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-architecture-"));
  const target = join(root, "src", path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
  return root;
}
