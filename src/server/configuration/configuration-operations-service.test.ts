// @vitest-environment node

import { describe, expect, it } from "vitest";

import { scrubSecrets } from "./configuration-operations-service";

describe("配置脱敏", () => {
  it("只遮蔽明确凭据字段并保留压缩 Token 数值", () => {
    expect(scrubSecrets({
      compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
      apiKey: "api-secret",
      accessToken: "access-secret",
    })).toEqual({
      compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
      apiKey: "[REDACTED]",
      accessToken: "[REDACTED]",
    });
  });
});
