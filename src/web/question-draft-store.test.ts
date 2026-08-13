import { beforeEach, describe, expect, it } from "vitest";

import type { PendingQuestionProjection } from "../shared/session-question-contracts";
import {
  clearAllQuestionDrafts,
  questionDraftStorageKey,
  readQuestionDraft,
  removeQuestionDraft,
  writeQuestionDraft,
} from "./question-draft-store";

const pending: PendingQuestionProjection = {
  id: "record/1",
  version: 2,
  toolCallId: "ask-1",
  createdAt: "2026-08-13T08:00:00.000Z",
  questions: [{
    id: "q-1",
    header: "范围",
    question: "处理范围？",
    multiSelect: false,
    options: [
      { id: "o-1", label: "全部", description: "全部处理" },
      { id: "o-2", label: "部分", description: "部分处理" },
    ],
  }],
};

describe("问题草稿本地存储", () => {
  beforeEach(() => window.localStorage.clear());

  it("按部署、会话、问题和版本隔离草稿", () => {
    const key = questionDraftStorageKey("session/1", pending);
    expect(key).toContain("bug-paw.question-draft.v1");
    expect(key).toContain(encodeURIComponent(window.location.origin));
    expect(key).toContain(encodeURIComponent("session/1"));
    expect(key).toContain(encodeURIComponent("record/1"));
    expect(key).toContain(":2");
  });

  it("读写有效草稿并过滤未知题目和选项", () => {
    writeQuestionDraft("session-1", pending, {
      questionIndex: 8,
      collapsed: true,
      updatedAt: "2026-08-13T08:10:00.000Z",
      answers: {
        "q-1": { optionIds: ["o-1", "unknown"], text: "" },
        unknown: { optionIds: ["o-2"], text: "泄露" },
      },
    });

    expect(readQuestionDraft("session-1", pending, new Date("2026-08-14T00:00:00.000Z"))).toEqual({
      questionIndex: 0,
      collapsed: true,
      updatedAt: "2026-08-13T08:10:00.000Z",
      answers: { "q-1": { optionIds: ["o-1"], text: "" } },
    });
  });

  it("丢弃损坏、错版本和超过 30 天的草稿", () => {
    const key = questionDraftStorageKey("session-1", pending);
    window.localStorage.setItem(key, "{broken");
    expect(readQuestionDraft("session-1", pending)).toMatchObject({ answers: {} });

    window.localStorage.setItem(key, JSON.stringify({
      questionRecordId: pending.id,
      version: 1,
      draft: { questionIndex: 0, collapsed: false, updatedAt: "2026-08-13T08:00:00.000Z", answers: {} },
    }));
    expect(readQuestionDraft("session-1", pending)).toMatchObject({ answers: {} });

    writeQuestionDraft("session-1", pending, {
      questionIndex: 0,
      collapsed: false,
      updatedAt: "2026-06-01T00:00:00.000Z",
      answers: {},
    });
    expect(readQuestionDraft("session-1", pending, new Date("2026-08-13T00:00:00.000Z"))).toMatchObject({ answers: {} });
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("只删除指定草稿或全部问题草稿，不影响主题设置", () => {
    writeQuestionDraft("session-1", pending, {
      questionIndex: 0,
      collapsed: false,
      updatedAt: new Date().toISOString(),
      answers: {},
    });
    window.localStorage.setItem("bugpaw:theme", "bug");
    removeQuestionDraft("session-1", pending);
    expect(window.localStorage.getItem(questionDraftStorageKey("session-1", pending))).toBeNull();

    window.localStorage.setItem(`${questionDraftStorageKey("session-1", pending)}:other`, "draft");
    clearAllQuestionDrafts();
    expect(window.localStorage.getItem("bugpaw:theme")).toBe("bug");
  });
});
