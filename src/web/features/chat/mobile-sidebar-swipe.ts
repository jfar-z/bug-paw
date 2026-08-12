import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const SWIPE_THRESHOLD_PX = 72;
const CLOSED_TRANSLATE_PERCENT = -102;
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

interface MobileSidebarSwipeOptions {
  open: boolean;
  onOpen(): void;
  onClose(): void;
}

interface SwipeStart {
  pointerId: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** 在移动端协调内容区右划打开和侧栏左划关闭。 */
export function useMobileSidebarSwipe(options: MobileSidebarSwipeOptions) {
  const gestureRef = useRef<SwipeStart | undefined>(undefined);
  const [translatePercent, setTranslatePercent] = useState<number | undefined>(undefined);

  const reset = () => {
    gestureRef.current = undefined;
    setTranslatePercent(undefined);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch" || !mobileSidebarEnabled()) return;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (!target) return;
    const region = target.closest<HTMLElement>(options.open ? ".chat-sidebar" : ".chat-workspace");
    if (!region || shouldIgnoreSidebarSwipe(target, region)) return;
    gestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0 };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.dx = event.clientX - gesture.x;
    gesture.dy = event.clientY - gesture.y;
    if (Math.abs(gesture.dy) > Math.abs(gesture.dx) && Math.abs(gesture.dy) > 12) {
      reset();
      return;
    }
    const directionalDistance = options.open ? -gesture.dx : gesture.dx;
    if (directionalDistance <= 0 || Math.abs(gesture.dx) < Math.abs(gesture.dy) * 1.25) return;
    event.preventDefault();
    const progress = Math.min(1, directionalDistance / sidebarGestureWidth());
    setTranslatePercent(options.open
      ? CLOSED_TRANSLATE_PERCENT * progress
      : CLOSED_TRANSLATE_PERCENT * (1 - progress));
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const decision = resolveSidebarSwipe(options.open, gesture.dx, gesture.dy);
    reset();
    if (decision === "open") options.onOpen();
    if (decision === "close") options.onClose();
  };

  return {
    swiping: translatePercent !== undefined,
    translatePercent,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: reset,
    },
  };
}

/** 根据方向、距离与水平意图决定侧栏最终状态。 */
export function resolveSidebarSwipe(open: boolean, dx: number, dy: number): "open" | "close" | undefined {
  if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(dy) * 1.25) return undefined;
  if (!open && dx > 0) return "open";
  if (open && dx < 0) return "close";
  return undefined;
}

/** 排除会与点击、代码选择、媒体操作或横向滚动冲突的起点。 */
export function shouldIgnoreSidebarSwipe(target: HTMLElement, boundary: HTMLElement): boolean {
  if (target.closest(BLOCKED_SWIPE_SELECTOR)) return true;
  for (let element: HTMLElement | null = target; element && element !== boundary; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    if (element.scrollWidth > element.clientWidth && (style.overflowX === "auto" || style.overflowX === "scroll")) return true;
  }
  return false;
}

function mobileSidebarEnabled(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 760px)").matches
    : window.innerWidth <= 760;
}

function sidebarGestureWidth(): number {
  return Math.min(310, window.innerWidth * 0.86);
}
