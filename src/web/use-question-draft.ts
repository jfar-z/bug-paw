import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PendingQuestionProjection, SubmittedQuestionAnswer } from "../shared/session-question-contracts";
import {
  createEmptyQuestionDraft,
  questionDraftStorageKey,
  readQuestionDraft,
  removeQuestionDraft,
  writeQuestionDraft,
  type QuestionDraft,
} from "./question-draft-store";

const QUESTION_DRAFT_CHANNEL = "bug-paw-question-drafts";
const TEXT_WRITE_DELAY_MS = 200;

export interface QuestionDraftController {
  draft: QuestionDraft;
  answeredCount: number;
  setQuestionIndex(index: number): void;
  toggleOption(questionId: string, optionId: string): void;
  setText(questionId: string, text: string): void;
  setCollapsed(collapsed: boolean): void;
  buildSubmission(): SubmittedQuestionAnswer[];
  clear(): void;
}

/** 管理只保存在浏览器中的提问草稿，并同步同源标签页。 */
export function useQuestionDraft(sessionId: string, pending: PendingQuestionProjection): QuestionDraftController {
  const key = questionDraftStorageKey(sessionId, pending);
  const [draft, setDraft] = useState<QuestionDraft>(() => readQuestionDraft(sessionId, pending));
  const draftRef = useRef(draft);
  const timerRef = useRef<number | undefined>(undefined);
  const channelRef = useRef<BroadcastChannel | undefined>(undefined);
  const clearedRef = useRef(false);

  const publish = useCallback(() => channelRef.current?.postMessage({ key }), [key]);
  const persist = useCallback((next: QuestionDraft) => {
    writeQuestionDraft(sessionId, pending, next);
    publish();
  }, [pending, publish, sessionId]);

  const update = useCallback((change: (current: QuestionDraft) => QuestionDraft, delayed = false) => {
    const next = { ...change(draftRef.current), updatedAt: new Date().toISOString() };
    draftRef.current = next;
    clearedRef.current = false;
    setDraft(next);
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    if (delayed) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        persist(draftRef.current);
      }, TEXT_WRITE_DELAY_MS);
    } else {
      persist(next);
    }
  }, [persist]);

  useEffect(() => {
    const next = readQuestionDraft(sessionId, pending);
    draftRef.current = next;
    setDraft(next);
    const receive = (changedKey: unknown) => {
      if (changedKey !== key) return;
      const synchronized = readQuestionDraft(sessionId, pending);
      draftRef.current = synchronized;
      setDraft(synchronized);
    };
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(QUESTION_DRAFT_CHANNEL);
      channelRef.current = channel;
      channel.onmessage = (event) => receive(isRecord(event.data) ? event.data.key : undefined);
      return () => {
        if (timerRef.current !== undefined && !clearedRef.current) writeQuestionDraft(sessionId, pending, draftRef.current);
        if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
        channel.close();
        channelRef.current = undefined;
      };
    }
    const onStorage = (event: StorageEvent) => receive(event.key);
    window.addEventListener("storage", onStorage);
    return () => {
      if (timerRef.current !== undefined && !clearedRef.current) writeQuestionDraft(sessionId, pending, draftRef.current);
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      window.removeEventListener("storage", onStorage);
    };
  }, [key, pending, sessionId]);

  const setQuestionIndex = useCallback((index: number) => update((current) => ({
    ...current,
    questionIndex: Math.max(0, Math.min(index, pending.questions.length - 1)),
  })), [pending.questions.length, update]);

  const toggleOption = useCallback((questionId: string, optionId: string) => {
    const question = pending.questions.find((item) => item.id === questionId);
    if (!question || !question.options.some((option) => option.id === optionId)) return;
    update((current) => {
      const answer = current.answers[questionId] ?? { optionIds: [], text: "" };
      const optionIds = question.multiSelect
        ? answer.optionIds.includes(optionId)
          ? answer.optionIds.filter((id) => id !== optionId)
          : [...answer.optionIds, optionId]
        : [optionId];
      return { ...current, answers: { ...current.answers, [questionId]: { optionIds, text: "" } } };
    });
  }, [pending.questions, update]);

  const setText = useCallback((questionId: string, text: string) => {
    if (!pending.questions.some((question) => question.id === questionId)) return;
    update((current) => ({
      ...current,
      answers: { ...current.answers, [questionId]: { optionIds: [], text } },
    }), true);
  }, [pending.questions, update]);

  const setCollapsed = useCallback((collapsed: boolean) => update((current) => ({ ...current, collapsed })), [update]);
  const buildSubmission = useCallback((): SubmittedQuestionAnswer[] => pending.questions.reduce<SubmittedQuestionAnswer[]>((answers, question) => {
    const answer = draftRef.current.answers[question.id];
    if (answer?.text.trim()) answers.push({ questionId: question.id, kind: "text", text: answer.text.trim() });
    else if (answer?.optionIds.length) answers.push({ questionId: question.id, kind: "options", optionIds: answer.optionIds });
    return answers;
  }, []), [pending.questions]);
  const clear = useCallback(() => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    clearedRef.current = true;
    removeQuestionDraft(sessionId, pending);
    publish();
    const next = createEmptyQuestionDraft();
    draftRef.current = next;
    setDraft(next);
  }, [pending, publish, sessionId]);
  const answeredCount = useMemo(() => pending.questions.filter((question) => {
    const answer = draft.answers[question.id];
    return Boolean(answer?.text.trim() || answer?.optionIds.length);
  }).length, [draft.answers, pending.questions]);

  return { draft, answeredCount, setQuestionIndex, toggleOption, setText, setCollapsed, buildSubmission, clear };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
