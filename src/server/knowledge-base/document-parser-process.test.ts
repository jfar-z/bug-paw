// @vitest-environment node

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SYSTEM_LIMITS } from "../core/limits";
import { parseKnowledgeDocument } from "./document-parser";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

/** 测试解析协议所需的最小子进程替身。 */
class FakeParserChild extends EventEmitter {
  /** 父进程写入 JSON 请求的输入流。 */
  readonly stdin = new PassThrough();
  /** 子进程返回唯一 JSON 结果的输出流。 */
  readonly stdout = new PassThrough();
  /** 记录父进程是否按约定强制终止异常解析。 */
  readonly kill = vi.fn(() => true);
}

describe("资料解析子进程协议", () => {
  let child: FakeParserChild;

  beforeEach(() => {
    child = new FakeParserChild();
    vi.mocked(spawn).mockReturnValue(child as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    child.stdin.destroy();
    child.stdout.destroy();
  });

  it("拒绝畸形 JSON 和非零退出", async () => {
    const malformed = parsePdf();
    child.stdout.write("not-json");
    child.emit("close", 0);
    await expect(malformed).rejects.toThrow("资料解析子进程返回无效结果");

    child = new FakeParserChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const crashed = parsePdf();
    child.emit("close", 137);
    await expect(crashed).rejects.toThrow("资料解析超过资源预算");
  });

  it("输出超限或读取失败时终止子进程", async () => {
    const oversized = parsePdf();
    child.stdout.write(Buffer.alloc(SYSTEM_LIMITS.knowledgeParserOutputBytes + 1));
    await expect(oversized).rejects.toThrow("资料解析结果超过系统上限");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child = new FakeParserChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const failed = parsePdf();
    child.stdout.emit("error", new Error("broken pipe"));
    await expect(failed).rejects.toThrow("资料解析结果读取失败");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("Abort 和超时均终止子进程并释放等待", async () => {
    const controller = new AbortController();
    const aborted = parsePdf(controller.signal);
    controller.abort(new DOMException("用户取消", "AbortError"));
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child = new FakeParserChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.useFakeTimers();
    const timedOut = parsePdf();
    const expectation = expect(timedOut).rejects.toThrow("资料解析超时");
    await vi.advanceTimersByTimeAsync(SYSTEM_LIMITS.knowledgeParseTimeoutMs);
    await expectation;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

/** 使用虚拟路径进入 PDF 子进程分支。 */
function parsePdf(signal?: AbortSignal) {
  return parseKnowledgeDocument({ mediaType: "application/pdf", path: "/data/test.pdf", signal });
}
