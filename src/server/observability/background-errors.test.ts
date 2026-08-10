// @vitest-environment node

import { describe, expect, it } from "vitest";
import { BackgroundErrorRegistry } from "./background-errors";

describe("BackgroundErrorRegistry", () => {
  it("有界保存脱敏后的后台错误摘要", () => {
    const registry = new BackgroundErrorRegistry(1);
    registry.record("OLD_ERROR", { taskId: "old" });
    registry.record("CHECKPOINT_WRITE_FAILED", {
      sessionId: "s1",
      apiKey: "secret-value",
      nested: { authorization: "Bearer secret", generation: 2 },
    });

    const summary = registry.summary();
    expect(summary).toMatchObject({ total: 1, latestCode: "CHECKPOINT_WRITE_FAILED" });
    expect(JSON.stringify(summary)).not.toContain("secret-value");
  });
});
