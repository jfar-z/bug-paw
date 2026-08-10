import { useEffect, useRef, useState } from "react";
import type { AppRoute } from "./router";

export const MOBILE_BACK_REQUEST_EVENT = "pi-agent:request-close-immersive-media";

const MOBILE_BACK_GUARD_KEY = "pi-agent-mobile-back-guard";
const EXIT_HINT_DURATION_MS = 2000;
const BACK_GESTURE_DEDUPLICATION_MS = 500;

interface MobileBackNavigationOptions {
  route: AppRoute;
  enabled: boolean;
  onNavigate: (route: AppRoute, replace?: boolean) => void;
}

/**
 * 为窄屏工作台提供分层返回行为，避免边缘返回直接离开当前工作流。
 *
 * Web 不能强制关闭浏览器或 PWA；第二次返回时仅放开 History 返回，由宿主决定退出方式。
 */
export function useMobileBackNavigation({ route, enabled, onNavigate }: MobileBackNavigationOptions) {
  const [showExitHint, setShowExitHint] = useState(false);
  const routeRef = useRef(route);
  const onNavigateRef = useRef(onNavigate);
  const exitHintActiveRef = useRef(false);
  const exitHintTimerRef = useRef<number | undefined>(undefined);
  const guardArmedAtRef = useRef(0);
  const guardIdRef = useRef(createBackGuardId());
  const routeRecoveryAtRef = useRef(0);

  routeRef.current = route;
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    if (!enabled) {
      exitHintActiveRef.current = false;
      guardArmedAtRef.current = 0;
      guardIdRef.current = createBackGuardId();
      routeRecoveryAtRef.current = 0;
      setShowExitHint(false);
      if (exitHintTimerRef.current !== undefined) {
        window.clearTimeout(exitHintTimerRef.current);
        exitHintTimerRef.current = undefined;
      }
      return;
    }

    const compactViewportQuery = window.matchMedia("(max-width: 760px)");
    const coarsePointerQuery = window.matchMedia("(pointer: coarse)");
    const standaloneDisplayQuery = window.matchMedia("(display-mode: standalone)");
    const isMobileContext = () => compactViewportQuery.matches || coarsePointerQuery.matches || standaloneDisplayQuery.matches;
    const armBackGuard = () => {
      if (isGuardState(window.history.state, guardIdRef.current)) return;
      const previousState = isRecord(window.history.state) ? window.history.state : {};
      window.history.pushState({ ...previousState, [MOBILE_BACK_GUARD_KEY]: guardIdRef.current }, "", currentUrl());
      guardArmedAtRef.current = Date.now();
    };
    const clearExitHint = () => {
      exitHintActiveRef.current = false;
      setShowExitHint(false);
      if (exitHintTimerRef.current !== undefined) {
        window.clearTimeout(exitHintTimerRef.current);
        exitHintTimerRef.current = undefined;
      }
    };
    const consumeImmersiveMediaBack = () => {
      const request = new Event(MOBILE_BACK_REQUEST_EVENT, { cancelable: true });
      if (!window.dispatchEvent(request)) return true;
      if (document.fullscreenElement) {
        void document.exitFullscreen?.();
        return true;
      }
      return false;
    };
    const onPopState = () => {
      if (!isMobileContext()) return;
      if (consumeImmersiveMediaBack()) {
        clearExitHint();
        armBackGuard();
        return;
      }
      if (routeRef.current.page !== "chat") {
        clearExitHint();
        routeRecoveryAtRef.current = Date.now();
        onNavigateRef.current({ page: "chat" }, true);
        armBackGuard();
        return;
      }
      if (Date.now() - routeRecoveryAtRef.current < BACK_GESTURE_DEDUPLICATION_MS) {
        clearExitHint();
        armBackGuard();
        return;
      }
      if (exitHintActiveRef.current) {
        if (Date.now() - guardArmedAtRef.current < BACK_GESTURE_DEDUPLICATION_MS) {
          armBackGuard();
          return;
        }
        clearExitHint();
        window.history.back();
        return;
      }
      exitHintActiveRef.current = true;
      setShowExitHint(true);
      exitHintTimerRef.current = window.setTimeout(clearExitHint, EXIT_HINT_DURATION_MS);
      armBackGuard();
    };
    const onMediaChange = () => {
      if (isMobileContext()) armBackGuard();
      else clearExitHint();
    };

    if (isMobileContext()) armBackGuard();
    window.addEventListener("popstate", onPopState);
    compactViewportQuery.addEventListener("change", onMediaChange);
    coarsePointerQuery.addEventListener("change", onMediaChange);
    standaloneDisplayQuery.addEventListener("change", onMediaChange);
    return () => {
      window.removeEventListener("popstate", onPopState);
      compactViewportQuery.removeEventListener("change", onMediaChange);
      coarsePointerQuery.removeEventListener("change", onMediaChange);
      standaloneDisplayQuery.removeEventListener("change", onMediaChange);
      clearExitHint();
    };
  }, [enabled]);

  return { showExitHint };
}

/** 判断当前 History state 是否由当前应用实例创建。 */
function isGuardState(state: unknown, guardId: string): boolean {
  return isRecord(state) && state[MOBILE_BACK_GUARD_KEY] === guardId;
}

/** 判断未知值是否可安全展开为 History state。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 保持守卫条目与当前路由完全相同，避免用户看到地址闪动。 */
function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/** 为每次应用加载创建独立标识，避免复用刷新前遗留的 History state。 */
function createBackGuardId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
