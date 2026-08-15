import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionTextSearchHit } from "../shared/session-text-search";
import { api } from "./api";

export type SessionSearchState = "idle" | "loading" | "success" | "empty" | "error" | "loadingMore";

/** 管理当前 Agent 会话文本搜索的防抖、取消、分页和迟到响应隔离。 */
export function useSessionSearch(agentId?: string) {
  const [query, setQueryValue] = useState("");
  const [hits, setHits] = useState<SessionTextSearchHit[]>([]);
  const [state, setState] = useState<SessionSearchState>("idle");
  const [error, setError] = useState<string>();
  const queryRef = useRef("");
  const cursorRef = useRef<string | undefined>(undefined);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const debounceConsumedQueryRef = useRef<string | undefined>(undefined);
  const [canLoadMore, setCanLoadMore] = useState(false);

  const cancelCurrent = useCallback(() => {
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = undefined;
  }, []);

  const setQuery = useCallback((nextQuery: string) => {
    cancelCurrent();
    queryRef.current = nextQuery;
    debounceConsumedQueryRef.current = undefined;
    cursorRef.current = undefined;
    setQueryValue(nextQuery);
    setHits([]);
    setCanLoadMore(false);
    setError(undefined);
    setState("idle");
  }, [cancelCurrent]);

  const runSearch = useCallback(async (loadMore: boolean) => {
    const currentQuery = queryRef.current;
    const cursor = loadMore ? cursorRef.current : undefined;
    if (!agentId || !currentQuery.trim() || (loadMore && !cursor)) return;
    debounceConsumedQueryRef.current = currentQuery;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(undefined);
    setState(loadMore ? "loadingMore" : "loading");
    try {
      const page = await api.searchSessions(agentId, {
        query: currentQuery,
        ...(cursor ? { cursor } : {}),
      }, controller.signal);
      if (requestIdRef.current !== requestId || queryRef.current !== currentQuery) return;
      cursorRef.current = page.nextCursor;
      setCanLoadMore(page.hasMore);
      setHits((current) => loadMore ? mergeHits(current, page.hits) : page.hits);
      const resultCount = loadMore ? undefined : page.hits.length;
      setState(resultCount === 0 ? "empty" : "success");
    } catch (reason) {
      if (controller.signal.aborted || requestIdRef.current !== requestId) return;
      setState("error");
      setError(reason instanceof Error ? reason.message : "搜索聊天记录失败");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = undefined;
    }
  }, [agentId]);

  const searchNow = useCallback(() => runSearch(false), [runSearch]);
  const loadMore = useCallback(() => runSearch(true), [runSearch]);
  const reset = useCallback(() => setQuery(""), [setQuery]);

  useEffect(() => {
    if (!agentId || !query.trim()) return;
    const timer = window.setTimeout(() => {
      if (debounceConsumedQueryRef.current !== query) void runSearch(false);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [agentId, query, runSearch]);

  useEffect(() => {
    cancelCurrent();
    queryRef.current = "";
    cursorRef.current = undefined;
    debounceConsumedQueryRef.current = undefined;
    setQueryValue("");
    setHits([]);
    setCanLoadMore(false);
    setError(undefined);
    setState("idle");
  }, [agentId, cancelCurrent]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { query, setQuery, hits, state, error, canLoadMore, searchNow, loadMore, reset };
}

/** 合并搜索下一页时按 Session 与 Entry 双键去重。 */
function mergeHits(current: readonly SessionTextSearchHit[], next: readonly SessionTextSearchHit[]): SessionTextSearchHit[] {
  const keys = new Set(current.map(({ sessionId, entryId }) => `${sessionId}\n${entryId}`));
  return [...current, ...next.filter(({ sessionId, entryId }) => !keys.has(`${sessionId}\n${entryId}`))];
}
