import { describe, expect, it } from "vitest";

import { createTestDatabase } from "../database/test-database";
import { BrowserAuditRepository } from "./browser-audit-repository";

/** 浏览器审计只保留安全决策和产物元数据。 */
describe("浏览器审计 Repository", () => {
  it("记录最小事件并按时间倒序读取", () => {
    const database = createTestDatabase();
    const repository = new BrowserAuditRepository(database);
    repository.record({
      id: "event-a",
      createdAt: "2026-08-12T08:00:00.000Z",
      agentId: "agent-a",
      sessionId: "session-a",
      runId: "run-a",
      toolName: "browser_download",
      operation: "download",
      origin: "https://example.com",
      finalOrigin: "https://cdn.example.com",
      decision: "allowed",
      queueWaitMs: 20,
      artifact: { path: "browser-artifacts/file.pdf", mediaType: "application/pdf", size: 8, sha256: "a".repeat(64) },
    });

    expect(repository.list(30)).toEqual([expect.objectContaining({ id: "event-a", operation: "download" })]);
    expect(JSON.stringify(repository.list(30))).not.toMatch(/页面正文|输入内容|Cookie|Authorization/u);
    database.close();
  });

  it("按保留期删除旧事件", () => {
    const database = createTestDatabase();
    const repository = new BrowserAuditRepository(database);
    repository.record(baseEvent("old", "2026-07-01T00:00:00.000Z"));
    repository.record(baseEvent("new", "2026-08-12T00:00:00.000Z"));

    expect(repository.prune("2026-08-01T00:00:00.000Z")).toBe(1);
    expect(repository.list(30).map((event) => event.id)).toEqual(["new"]);
    database.close();
  });
});

/** 创建不含页面内容的审计事件。 */
function baseEvent(id: string, createdAt: string) {
  return {
    id,
    createdAt,
    agentId: "agent-a",
    sessionId: "session-a",
    runId: "run-a",
    toolName: "browser_open",
    operation: "open",
    origin: "https://example.com",
    decision: "allowed" as const,
  };
}
