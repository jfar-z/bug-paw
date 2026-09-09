import type { ErrorToastInput } from "./error-toast-types";

const GLOBAL_ERROR_EVENT = "bugpaw:global-error";

/** 向 React 根节点之外的浏览器生命周期代码分发可观测错误。 */
export function reportGlobalError(input: ErrorToastInput): void {
  window.dispatchEvent(new CustomEvent<ErrorToastInput>(GLOBAL_ERROR_EVENT, { detail: input }));
}

/** 订阅 React 根节点之外分发的错误事件。 */
export function subscribeGlobalErrors(listener: (input: ErrorToastInput) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ErrorToastInput>).detail);
  window.addEventListener(GLOBAL_ERROR_EVENT, handler);
  return () => window.removeEventListener(GLOBAL_ERROR_EVENT, handler);
}
