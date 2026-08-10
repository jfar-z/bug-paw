// @vitest-environment node

import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "./sensitive-text";

describe("redactSensitiveText", () => {
  it("隐藏认证头、URL 凭证、查询参数和自定义秘密字段", () => {
    const value = [
      "Basic dXNlcjpwYXNz",
      "https://alice:secret@example.test/v1?api_key=query-secret&signature=signed",
      'clientSecret="client-secret" password=pwd authorization: custom-secret',
    ].join(" ");

    const result = redactSensitiveText(value, 500);

    expect(result).not.toContain("dXNlcjpwYXNz");
    expect(result).not.toContain("alice:secret");
    expect(result).not.toContain("query-secret");
    expect(result).not.toContain("signed");
    expect(result).not.toContain("client-secret");
    expect(result).not.toContain("pwd");
    expect(result).not.toContain("custom-secret");
  });

  it("按 Unicode 字符而非 UTF-16 单元截断", () => {
    expect(redactSensitiveText("甲😀乙", 2)).toBe("甲😀");
  });
});
