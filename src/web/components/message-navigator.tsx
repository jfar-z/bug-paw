import { useEffect, useState, type RefObject } from "react";

const MESSAGE_TOP_GAP = 32;

export interface MessageNavigationEntry {
  id: string;
  summary: string;
  targetRef?: RefObject<HTMLElement | null>;
  targetId?: string;
}

interface MessageNavigatorProps {
  items: MessageNavigationEntry[];
  scrollContainerRef: RefObject<HTMLElement | null>;
}

/**
 * 展示用户消息的快速导航入口。
 */
export function MessageNavigator({ items, scrollContainerRef }: MessageNavigatorProps) {
  const [activeId, setActiveId] = useState<string | undefined>(items[0]?.id);

  useEffect(() => {
    if (items.length === 0) {
      setActiveId(undefined);
      return;
    }

    setActiveId((currentId) => (items.some((item) => item.id === currentId) ? currentId : items[0].id));

    const container = scrollContainerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") {
      return;
    }

    const itemIds = new Map<Element, string>();
    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntry = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
        const visibleId = visibleEntry ? itemIds.get(visibleEntry.target) : undefined;
        if (visibleId) {
          setActiveId(visibleId);
        }
      },
      {
        root: container,
        rootMargin: "-15% 0px -65% 0px",
      },
    );

    items.forEach((item) => {
      const target = resolveTarget(item, container);
      if (target) {
        itemIds.set(target, item.id);
        observer.observe(target);
      }
    });

    return () => {
      observer.disconnect();
    };
  }, [items, scrollContainerRef]);

  /**
   * 只移动对话容器，避免影响应用所在页面的外层滚动位置。
   */
  function navigateTo(item: MessageNavigationEntry) {
    const container = scrollContainerRef.current;
    const target = container ? resolveTarget(item, container) : undefined;
    if (!container || !target) {
      return;
    }

    const top =
      container.scrollTop +
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      MESSAGE_TOP_GAP;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    container.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
    setActiveId(item.id);
  }

  if (items.length === 0) {
    return null;
  }

  return (
    <nav className="message-navigator" aria-label="用户消息导航">
      <ol>
        {items.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              aria-label={`跳转到用户消息 ${index + 1}：${item.summary}`}
              aria-current={activeId === item.id ? "location" : undefined}
              onClick={() => navigateTo(item)}
            >
              <span className="message-navigator__marker" aria-hidden="true" />
              <span className="message-navigator__summary">{item.summary}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * 优先使用显式引用，并允许实时消息通过稳定 DOM ID 延迟定位。
 */
function resolveTarget(item: MessageNavigationEntry, container: HTMLElement): HTMLElement | undefined {
  const referenced = item.targetRef?.current;
  if (referenced) {
    return referenced;
  }
  if (!item.targetId) {
    return undefined;
  }
  const target = Array.from(container.querySelectorAll<HTMLElement>("[id]"))
    .find((candidate) => candidate.id === item.targetId);
  return target;
}
