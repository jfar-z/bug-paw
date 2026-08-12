import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const SWIPE_THRESHOLD_PX = 72;
const CLOSED_TRANSLATE_PERCENT = 102;
const HORIZONTAL_INTENT_RATIO = 1.25;
const BLOCKED_SWIPE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='button']",
  "pre",
  "code",
  "img",
  "video",
  "audio",
  "canvas",
  ".media-lightbox",
  ".mermaid-diagram",
].join(",");

export type MobileWorkspaceDrawer = "sessions" | "resources";

export interface MobileWorkspaceSwipeOptions {
  openDrawer?: MobileWorkspaceDrawer;
  onOpenDrawer(drawer: MobileWorkspaceDrawer): void;
  onCloseDrawer(drawer: MobileWorkspaceDrawer): void;
}

interface SwipeGesture {
  pointerId: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  drawer?: MobileWorkspaceDrawer;
  capturedBy?: HTMLElement;
}

/** 统一协调移动端左侧会话与右侧资源抽屉的跟手手势。 */
export function useMobileWorkspaceSwipe(options: MobileWorkspaceSwipeOptions) {
  const gestureRef = useRef<SwipeGesture>();
  const [sessionTranslatePercent, setSessionTranslatePercent] = useState<number>();
  const [resourceTranslatePercent, setResourceTranslatePercent] = useState<number>();

  const clearGesture = (pointerId?: number) => {
    const gesture = gestureRef.current;
    if (gesture?.capturedBy && (pointerId === undefined || pointerId === gesture.pointerId)) {
      try {
        gesture.capturedBy.releasePointerCapture?.(gesture.pointerId);
      } catch {
        // 指针可能已经由浏览器释放，清理状态仍需继续。
      }
    }
    gestureRef.current = undefined;
    setSessionTranslatePercent(undefined);
    setResourceTranslatePercent(undefined);
  };

  useEffect(() => () => clearGesture(), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch" || !mobileWorkspaceSwipeEnabled()) return;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (!target || shouldIgnoreWorkspaceSwipe(target, event.currentTarget)) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dx: 0,
      dy: 0,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    updateDistance(gesture, event.clientX, event.clientY);
    if (Math.abs(gesture.dy) > Math.abs(gesture.dx) && Math.abs(gesture.dy) > 12) {
      clearGesture(event.pointerId);
      return;
    }
    const drawer = gesture.drawer ?? resolveGestureDrawer(options.openDrawer, gesture.dx, gesture.dy);
    if (!drawer) return;
    gesture.drawer = drawer;
    if (!gesture.capturedBy) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      gesture.capturedBy = event.currentTarget;
    }
    event.preventDefault();
    const progress = Math.min(1, directionalDistance(options.openDrawer, drawer, gesture.dx) / drawerGestureWidth());
    if (drawer === "sessions") {
      setSessionTranslatePercent(options.openDrawer === "sessions"
        ? -CLOSED_TRANSLATE_PERCENT * progress
        : -CLOSED_TRANSLATE_PERCENT * (1 - progress));
    } else {
      setResourceTranslatePercent(options.openDrawer === "resources"
        ? CLOSED_TRANSLATE_PERCENT * progress
        : CLOSED_TRANSLATE_PERCENT * (1 - progress));
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    updateDistance(gesture, event.clientX, event.clientY);
    const decision = resolveWorkspaceSwipe(options.openDrawer, gesture.dx, gesture.dy);
    clearGesture(event.pointerId);
    if (decision?.action === "open") options.onOpenDrawer(decision.drawer);
    if (decision?.action === "close") options.onCloseDrawer(decision.drawer);
  };

  return {
    swiping: sessionTranslatePercent !== undefined || resourceTranslatePercent !== undefined,
    sessionTranslatePercent,
    resourceTranslatePercent,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
  };
}

/** 根据最终位移决定打开或关闭哪一侧抽屉。 */
export function resolveWorkspaceSwipe(
  openDrawer: MobileWorkspaceDrawer | undefined,
  dx: number,
  dy: number,
): { action: "open" | "close"; drawer: MobileWorkspaceDrawer } | undefined {
  if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(dy) * HORIZONTAL_INTENT_RATIO) return undefined;
  if (!openDrawer && dx > 0) return { action: "open", drawer: "sessions" };
  if (!openDrawer && dx < 0) return { action: "open", drawer: "resources" };
  if (openDrawer === "sessions" && dx < 0) return { action: "close", drawer: "sessions" };
  if (openDrawer === "resources" && dx > 0) return { action: "close", drawer: "resources" };
  return undefined;
}

/** 排除会与点击、文本选择、媒体操作或横向滚动冲突的起点。 */
export function shouldIgnoreWorkspaceSwipe(target: HTMLElement, boundary: HTMLElement): boolean {
  if (target.closest(BLOCKED_SWIPE_SELECTOR)) return true;
  for (let element: HTMLElement | null = target; element && element !== boundary; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    if (element.scrollWidth > element.clientWidth && (style.overflowX === "auto" || style.overflowX === "scroll")) return true;
  }
  return false;
}

function resolveGestureDrawer(
  openDrawer: MobileWorkspaceDrawer | undefined,
  dx: number,
  dy: number,
): MobileWorkspaceDrawer | undefined {
  if (Math.abs(dx) < Math.abs(dy) * HORIZONTAL_INTENT_RATIO || dx === 0) return undefined;
  if (!openDrawer) return dx > 0 ? "sessions" : "resources";
  if (openDrawer === "sessions" && dx < 0) return "sessions";
  if (openDrawer === "resources" && dx > 0) return "resources";
  return undefined;
}

function directionalDistance(
  openDrawer: MobileWorkspaceDrawer | undefined,
  drawer: MobileWorkspaceDrawer,
  dx: number,
): number {
  if (openDrawer === "sessions") return Math.max(0, -dx);
  if (openDrawer === "resources") return Math.max(0, dx);
  return drawer === "sessions" ? Math.max(0, dx) : Math.max(0, -dx);
}

function updateDistance(gesture: SwipeGesture, clientX: number, clientY: number): void {
  gesture.dx = clientX - gesture.x;
  gesture.dy = clientY - gesture.y;
}

function mobileWorkspaceSwipeEnabled(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 760px)").matches
    : window.innerWidth <= 760;
}

function drawerGestureWidth(): number {
  return Math.min(310, window.innerWidth * 0.86);
}
