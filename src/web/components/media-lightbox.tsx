import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { WorkspaceFileSummary } from "../../shared/contracts";
import { workspaceFileUrl } from "../api";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";

interface MediaLightboxProps {
  item: WorkspaceFileSummary;
  images: WorkspaceFileSummary[];
  agentId?: string;
  onClose: () => void;
}

const DISMISS_GUARD_DURATION_MS = 180;
const SWIPE_DISTANCE_PX = 48;
const MIN_SCALE = 1;
const MAX_SCALE = 4;
const SCALE_STEP = 1;

interface PointerPosition {
  x: number;
  y: number;
}

interface DragOrigin extends PointerPosition {
  pointerId: number;
  translateX: number;
  translateY: number;
}

/**
 * 展示会话附件的全屏图片画廊，并在关闭时隔离后续指针事件。
 */
export function MediaLightbox({ item, images, agentId = "default", onClose }: MediaLightboxProps) {
  const [closing, setClosing] = useState(false);
  const [scale, setScale] = useState(MIN_SCALE);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dismissTimerRef = useRef<number | undefined>(undefined);
  const swipeStartRef = useRef<{ pointerId: number; x: number } | undefined>(undefined);
  const pointersRef = useRef(new Map<number, PointerPosition>());
  const pinchRef = useRef<{ distance: number; scale: number } | undefined>(undefined);
  const dragOriginRef = useRef<DragOrigin | undefined>(undefined);
  const imageIndex = Math.max(0, images.findIndex((image) => image.path === item.path));
  const [activeIndex, setActiveIndex] = useState(imageIndex);
  const activeImage = images[activeIndex] ?? item;

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    dismissTimerRef.current = window.setTimeout(onClose, DISMISS_GUARD_DURATION_MS);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closing]);

  useEffect(() => {
    const onMobileBackRequest = (event: Event) => {
      event.preventDefault();
      requestClose();
    };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, onMobileBackRequest);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, onMobileBackRequest);
  }, [closing]);

  useEffect(() => () => {
    if (dismissTimerRef.current !== undefined) window.clearTimeout(dismissTimerRef.current);
  }, []);

  useEffect(() => {
    setScale(MIN_SCALE);
    setTranslate({ x: 0, y: 0 });
    setDragging(false);
    pointersRef.current.clear();
    pinchRef.current = undefined;
    dragOriginRef.current = undefined;
  }, [activeIndex]);

  const updateScale = (nextScale: number) => {
    const boundedScale = Math.min(Math.max(nextScale, MIN_SCALE), MAX_SCALE);
    setScale(boundedScale);
    if (boundedScale === MIN_SCALE) setTranslate({ x: 0, y: 0 });
  };

  const resetZoom = () => {
    setScale(MIN_SCALE);
    setTranslate({ x: 0, y: 0 });
  };

  const changeImage = (offset: number) => {
    setActiveIndex((current) => Math.min(Math.max(current + offset, 0), images.length - 1));
  };

  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (closing) return;
    const point = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, point);
    if (pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()];
      pinchRef.current = { distance: distanceBetween(first, second), scale };
      dragOriginRef.current = undefined;
      setDragging(false);
      return;
    }
    if (scale > MIN_SCALE) {
      dragOriginRef.current = { pointerId: event.pointerId, ...point, translateX: translate.x, translateY: translate.y };
      setDragging(true);
      return;
    }
    swipeStartRef.current = { pointerId: event.pointerId, x: event.clientX };
  };

  const onStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const point = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, point);
    const pointerPositions = [...pointersRef.current.values()];
    if (pointerPositions.length === 2 && pinchRef.current) {
      const nextDistance = distanceBetween(pointerPositions[0], pointerPositions[1]);
      updateScale(pinchRef.current.scale * (nextDistance / pinchRef.current.distance));
      return;
    }
    const dragOrigin = dragOriginRef.current;
    if (dragOrigin?.pointerId === event.pointerId) {
      setTranslate({ x: dragOrigin.translateX + point.x - dragOrigin.x, y: dragOrigin.translateY + point.y - dragOrigin.y });
    }
  };

  const onStagePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = undefined;
    if (start?.pointerId === event.pointerId && scale === MIN_SCALE) {
      const distance = event.clientX - start.x;
      if (distance <= -SWIPE_DISTANCE_PX) changeImage(1);
      if (distance >= SWIPE_DISTANCE_PX) changeImage(-1);
    }
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = undefined;
    if (dragOriginRef.current?.pointerId === event.pointerId) dragOriginRef.current = undefined;
    setDragging(false);
  };

  if (closing) {
    return <div className="media-lightbox__dismiss-guard" data-testid="media-lightbox-dismiss-guard" aria-hidden="true" />;
  }

  return (
    <div
      className="media-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="媒体预览"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <button
        type="button"
        className="media-lightbox__close"
        aria-label="关闭全屏预览"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          requestClose();
        }}
      >
        <X size={22} aria-hidden="true" />
      </button>
      <div
        className="media-lightbox__stage"
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerEnd}
        onPointerCancel={onStagePointerEnd}
        onDoubleClick={() => updateScale(scale > MIN_SCALE ? MIN_SCALE : 2)}
        onWheel={(event) => {
          event.preventDefault();
          updateScale(scale + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP));
        }}
      >
        <img
          className={dragging ? "is-dragging" : scale > MIN_SCALE ? "is-zoomed" : undefined}
          src={workspaceFileUrl(agentId, activeImage.path)}
          alt={activeImage.name}
          style={{ transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})` }}
        />
      </div>
      <div className="media-lightbox__controls">
        {images.length > 1 ? (
          <div className="media-lightbox__image-controls" aria-label="图片切换">
            <button type="button" aria-label="上一张图片" disabled={activeIndex === 0} onClick={() => changeImage(-1)}><ChevronLeft size={22} aria-hidden="true" /></button>
            <span>{activeIndex + 1} / {images.length}</span>
            <button type="button" aria-label="下一张图片" disabled={activeIndex === images.length - 1} onClick={() => changeImage(1)}><ChevronRight size={22} aria-hidden="true" /></button>
          </div>
        ) : null}
        <div className="media-lightbox__zoom-controls" aria-label="图片缩放">
          <button type="button" aria-label="缩小图片" disabled={scale <= MIN_SCALE} onClick={() => updateScale(scale - SCALE_STEP)}><Minus size={18} aria-hidden="true" /></button>
          <button type="button" aria-label="重置图片缩放" onClick={resetZoom}><span aria-label="当前缩放比例">{Math.round(scale * 100)}%</span></button>
          <button type="button" aria-label="放大图片" disabled={scale >= MAX_SCALE} onClick={() => updateScale(scale + SCALE_STEP)}><Plus size={18} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
  );
}

function distanceBetween(first: PointerPosition, second: PointerPosition): number {
  return Math.hypot(first.x - second.x, first.y - second.y) || 1;
}
