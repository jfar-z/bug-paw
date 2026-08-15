import { describe, expect, it } from "vitest";

import { sortSessionsPinnedFirst } from "./session-sort";

describe("Session 置顶排序", () => {
  it("置顶优先且两个分组内部按最近时间和 ID 稳定排序", () => {
    const sorted = sortSessionsPinnedFirst([
      { id: "normal-old", modified: "2026-08-01T00:00:00.000Z", pinned: false },
      { id: "pin-b", modified: "2026-08-03T00:00:00.000Z", pinned: true },
      { id: "normal-new", modified: "2026-08-04T00:00:00.000Z", pinned: false },
      { id: "pin-a", modified: "2026-08-03T00:00:00.000Z", pinned: true },
    ]);

    expect(sorted.map(({ id }) => id)).toEqual(["pin-a", "pin-b", "normal-new", "normal-old"]);
  });

  it("不修改调用方持有的原数组", () => {
    const sessions = [
      { id: "normal", modified: "2026-08-04T00:00:00.000Z", pinned: false },
      { id: "pinned", modified: "2026-08-03T00:00:00.000Z", pinned: true },
    ];

    sortSessionsPinnedFirst(sessions);

    expect(sessions.map(({ id }) => id)).toEqual(["normal", "pinned"]);
  });
});
