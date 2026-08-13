import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingQuestionProjection } from "../shared/session-question-contracts";
import { questionDraftStorageKey } from "./question-draft-store";
import { useQuestionDraft } from "./use-question-draft";

class FakeBroadcastChannel {
  static channels: FakeBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) { FakeBroadcastChannel.channels.push(this); }
  postMessage(data: unknown) {
    FakeBroadcastChannel.channels.filter((channel) => channel !== this && channel.name === this.name)
      .forEach((channel) => channel.onmessage?.({ data } as MessageEvent));
  }
  close() { FakeBroadcastChannel.channels = FakeBroadcastChannel.channels.filter((channel) => channel !== this); }
}

const pending: PendingQuestionProjection = {
  id: "record-1",
  version: 1,
  toolCallId: "ask-1",
  createdAt: "2026-08-13T08:00:00.000Z",
  questions: [{
    id: "q-1",
    header: "范围",
    question: "处理范围？",
    multiSelect: true,
    options: [
      { id: "o-1", label: "全部", description: "全部处理" },
      { id: "o-2", label: "部分", description: "部分处理" },
    ],
  }],
};

describe("useQuestionDraft", () => {
  beforeEach(() => {
    window.localStorage.clear();
    FakeBroadcastChannel.channels = [];
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  });

  it("选项立即落本地，文本防抖约 200ms 且二者互斥", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useQuestionDraft("session-1", pending));

    act(() => result.current.toggleOption("q-1", "o-1"));
    expect(window.localStorage.getItem(questionDraftStorageKey("session-1", pending))).toContain("o-1");

    act(() => result.current.setText("q-1", "改用文字说明"));
    expect(result.current.draft.answers["q-1"]).toEqual({ optionIds: [], text: "改用文字说明" });
    expect(window.localStorage.getItem(questionDraftStorageKey("session-1", pending))).not.toContain("改用文字说明");
    act(() => vi.advanceTimersByTime(200));
    expect(window.localStorage.getItem(questionDraftStorageKey("session-1", pending))).toContain("改用文字说明");

    act(() => result.current.toggleOption("q-1", "o-2"));
    expect(result.current.draft.answers["q-1"]).toEqual({ optionIds: ["o-2"], text: "" });
    vi.useRealTimers();
  });

  it("允许空答案和部分答案构建提交，并同步另一个标签页", () => {
    const first = renderHook(() => useQuestionDraft("session-1", pending));
    const second = renderHook(() => useQuestionDraft("session-1", pending));
    expect(first.result.current.buildSubmission()).toEqual([]);

    act(() => first.result.current.toggleOption("q-1", "o-2"));

    expect(second.result.current.draft.answers["q-1"]).toEqual({ optionIds: ["o-2"], text: "" });
    expect(first.result.current.buildSubmission()).toEqual([
      { questionId: "q-1", kind: "options", optionIds: ["o-2"] },
    ]);
  });

  it("清理后移除当前草稿", () => {
    const { result } = renderHook(() => useQuestionDraft("session-1", pending));
    act(() => result.current.toggleOption("q-1", "o-1"));
    act(() => result.current.clear());

    expect(window.localStorage.getItem(questionDraftStorageKey("session-1", pending))).toBeNull();
    expect(result.current.draft.answers).toEqual({});
  });
});
