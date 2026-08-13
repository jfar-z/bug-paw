import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { SessionHistoryResult } from "../shared/session-history-contracts";
import { api, type SessionSnapshot } from "./api";

export type SessionHistoryLoadState = "idle" | "loading" | "error" | "complete";

interface UseSessionHistoryOptions {
  snapshot?: SessionSnapshot;
  focused?: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onPrepend(page: SessionHistoryResult): void;
  onAppend?(page: SessionHistoryResult): void;
  onBeforePrepend?(): void;
  onError(error: unknown): void;
  onNewerError?(error: unknown): void;
}

interface ScrollAnchor {
  height: number;
  top: number;
}

/** 自动加载当前树分支的更早轮次，并在前置内容后恢复原视口锚点。 */
export function useSessionHistory(options: UseSessionHistoryOptions) {
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const [newerSentinel, setNewerSentinel] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<SessionHistoryLoadState>("idle");
  const [newerState, setNewerState] = useState<SessionHistoryLoadState>("idle");
  const requestRef = useRef<AbortController | undefined>(undefined);
  const newerRequestRef = useRef<AbortController | undefined>(undefined);
  const requestedKeyRef = useRef<string | undefined>(undefined);
  const newerRequestedKeyRef = useRef<string | undefined>(undefined);
  const anchorRef = useRef<ScrollAnchor | undefined>(undefined);
  const latestRef = useRef(options);
  latestRef.current = options;

  const sessionId = options.snapshot?.id;
  const before = options.snapshot?.history?.startEntryId;
  const branchToken = options.snapshot?.history?.branchToken;
  const hasMore = options.snapshot?.history?.hasMoreBefore ?? false;
  const after = options.snapshot?.history?.endEntryId;
  const hasMoreAfter = options.focused && (options.snapshot?.history?.hasMoreAfter ?? false);
  const requestKey = sessionId && before && branchToken ? `${sessionId}\n${branchToken}\n${before}` : undefined;
  const newerRequestKey = sessionId && after && branchToken ? `${sessionId}\n${branchToken}\n${after}` : undefined;

  const load = useCallback(async () => {
    const current = latestRef.current.snapshot;
    const currentBefore = current?.history.startEntryId;
    if (!current?.history || !currentBefore || !current.history.hasMoreBefore) return;
    const key = `${current.id}\n${current.history.branchToken}\n${currentBefore}`;
    if (requestRef.current || requestedKeyRef.current === key) return;
    requestedKeyRef.current = key;
    const controller = new AbortController();
    requestRef.current = controller;
    setState("loading");
    try {
      const page = await api.loadSessionHistory(current.id, currentBefore, current.history.branchToken, controller.signal);
      const latest = latestRef.current.snapshot;
      if (!latest
        || latest.id !== current.id
        || latest.history.branchToken !== current.history.branchToken
        || latest.history.startEntryId !== currentBefore) return;
      const container = latestRef.current.scrollRef.current;
      if (container) anchorRef.current = { height: container.scrollHeight, top: container.scrollTop };
      latestRef.current.onBeforePrepend?.();
      latestRef.current.onPrepend(page);
      setState(page.history.hasMoreBefore ? "idle" : "complete");
    } catch (error) {
      if (controller.signal.aborted) return;
      setState("error");
      latestRef.current.onError(error);
    } finally {
      if (requestRef.current === controller) requestRef.current = undefined;
    }
  }, []);

  const retry = useCallback(() => {
    requestedKeyRef.current = undefined;
    void load();
  }, [load]);

  const loadNewer = useCallback(async () => {
    const currentOptions = latestRef.current;
    const current = currentOptions.snapshot;
    const currentAfter = current?.history.endEntryId;
    if (!currentOptions.focused || !current?.history || !currentAfter || !current.history.hasMoreAfter || !currentOptions.onAppend) return;
    const key = `${current.id}\n${current.history.branchToken}\n${currentAfter}`;
    if (newerRequestRef.current || newerRequestedKeyRef.current === key) return;
    newerRequestedKeyRef.current = key;
    const controller = new AbortController();
    newerRequestRef.current = controller;
    setNewerState("loading");
    try {
      const page = await api.loadSessionHistoryAfter(current.id, currentAfter, current.history.branchToken, controller.signal);
      const latest = latestRef.current.snapshot;
      if (!latest
        || latest.id !== current.id
        || latest.history.branchToken !== current.history.branchToken
        || latest.history.endEntryId !== currentAfter) return;
      latestRef.current.onAppend?.(page);
      setNewerState(page.history.hasMoreAfter ? "idle" : "complete");
    } catch (error) {
      if (controller.signal.aborted) return;
      setNewerState("error");
      (latestRef.current.onNewerError ?? latestRef.current.onError)(error);
    } finally {
      if (newerRequestRef.current === controller) newerRequestRef.current = undefined;
    }
  }, []);

  const retryNewer = useCallback(() => {
    newerRequestedKeyRef.current = undefined;
    void loadNewer();
  }, [loadNewer]);

  useEffect(() => {
    requestedKeyRef.current = undefined;
    requestRef.current?.abort();
    requestRef.current = undefined;
    newerRequestedKeyRef.current = undefined;
    newerRequestRef.current?.abort();
    newerRequestRef.current = undefined;
    setState(hasMore ? "idle" : options.snapshot?.messages?.length ? "complete" : "idle");
    setNewerState(hasMoreAfter ? "idle" : options.focused && options.snapshot?.messages?.length ? "complete" : "idle");
  }, [branchToken, sessionId, options.focused]);

  useEffect(() => {
    if (!sentinel || !hasMore || !requestKey || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load();
    }, { root: options.scrollRef.current, rootMargin: "240px 0px 0px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, load, options.scrollRef, requestKey, sentinel]);

  useEffect(() => {
    if (!newerSentinel || !hasMoreAfter || !newerRequestKey || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadNewer();
    }, { root: options.scrollRef.current, rootMargin: "0px 0px 240px 0px" });
    observer.observe(newerSentinel);
    return () => observer.disconnect();
  }, [hasMoreAfter, loadNewer, newerRequestKey, newerSentinel, options.scrollRef]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const container = options.scrollRef.current;
    if (!anchor || !container) return;
    anchorRef.current = undefined;
    container.scrollTop = anchor.top + (container.scrollHeight - anchor.height);
  }, [before, options.scrollRef]);

  useEffect(() => () => {
    requestRef.current?.abort();
    newerRequestRef.current?.abort();
  }, []);

  return { sentinelRef: setSentinel, state, retry, newerSentinelRef: setNewerSentinel, newerState, retryNewer };
}
