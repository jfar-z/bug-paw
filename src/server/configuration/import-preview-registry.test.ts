// @vitest-environment node

import { describe, expect, it } from "vitest";

import { ImportPreviewRegistry } from "./import-preview-registry";

describe("ImportPreviewRegistry", () => {
  it("最多保留 20 个未过期预览并淘汰最旧项", () => {
    let now = 0;
    const registry = new ImportPreviewRegistry<string>({ now: () => now, maxEntries: 20, ttlMs: 1_000 });
    for (let index = 0; index < 21; index += 1) {
      registry.create(`p${index}`, `value-${index}`);
      now += 1;
    }

    expect(registry.size).toBe(20);
    expect(() => registry.consume("p0")).toThrow(expect.objectContaining({ code: "IMPORT_PREVIEW_EXPIRED" }));
    expect(registry.consume("p20")).toBe("value-20");
  });

  it("预览只能消费一次且过期项会被清理", () => {
    let now = 10;
    const registry = new ImportPreviewRegistry<string>({ now: () => now, maxEntries: 2, ttlMs: 100 });
    registry.create("once", "payload");
    expect(registry.consume("once")).toBe("payload");
    expect(() => registry.consume("once")).toThrow(expect.objectContaining({ code: "IMPORT_PREVIEW_EXPIRED" }));

    registry.create("expired", "payload");
    now = 111;
    registry.sweep();
    expect(registry.size).toBe(0);
  });
});
