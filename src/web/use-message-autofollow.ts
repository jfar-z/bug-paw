import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const BOTTOM_THRESHOLD = 48;

export interface MessageAutofollowControls {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  resumeFollowing: () => void;
  pauseFollowing: () => void;
  /**
   * 在下一次内容提交后仅执行一次底部对齐，避免切换会话时跟随异步高度变化。
   */
  alignAfterNextContentCommit: () => void;
}

/**
 * 在用户接近底部时持续跟随消息增长，主动上滚后暂停自动跟随。
 */
export function useMessageAutofollow(contentVersion: unknown): MessageAutofollowControls {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const alignAfterNextContentCommitRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  const resumeFollowing = useCallback(() => {
    followingRef.current = true;
    scrollToBottom();
  }, [scrollToBottom]);

  const pauseFollowing = useCallback(() => {
    followingRef.current = false;
  }, []);

  const alignAfterNextContentCommit = useCallback(() => {
    followingRef.current = false;
    alignAfterNextContentCommitRef.current = true;
  }, []);

  useLayoutEffect(() => {
    if (alignAfterNextContentCommitRef.current) {
      alignAfterNextContentCommitRef.current = false;
      scrollToBottom();
      return;
    }
    if (followingRef.current) {
      scrollToBottom();
    }
  }, [contentVersion, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!container || !content) {
      return;
    }

    const updateFollowing = () => {
      const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      followingRef.current = distanceToBottom <= BOTTOM_THRESHOLD;
    };
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
        if (followingRef.current) {
          scrollToBottom();
        }
      });

    container.addEventListener("scroll", updateFollowing, { passive: true });
    observer?.observe(content);
    return () => {
      container.removeEventListener("scroll", updateFollowing);
      observer?.disconnect();
    };
  }, [scrollToBottom]);

  return { scrollContainerRef, contentRef, resumeFollowing, pauseFollowing, alignAfterNextContentCommit };
}
