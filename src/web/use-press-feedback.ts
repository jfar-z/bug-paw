import { useEffect } from "react";

const INTERACTIVE_SELECTOR = "button, a[href], [role='button'], .attachment-picker__button";

/**
 * 为应用内可点击控件提供跨鼠标和触摸设备的一致按下状态。
 */
export function usePressFeedback(): void {
  useEffect(() => {
    let pressedControl: HTMLElement | undefined;

    const clearPressed = () => {
      pressedControl?.classList.remove("is-pressing");
      pressedControl = undefined;
    };

    const press = (event: PointerEvent) => {
      clearPressed();
      if (!(event.target instanceof Element)) {
        return;
      }
      const control = event.target.closest<HTMLElement>(INTERACTIVE_SELECTOR);
      if (!control || isDisabledControl(control)) {
        return;
      }
      // 会话正文与操作菜单共同构成一个视觉区域，按下时统一反馈整行。
      const feedbackSurface = control.closest<HTMLElement>(".session-row") ?? control;
      pressedControl = feedbackSurface;
      feedbackSurface.classList.add("is-pressing");
    };

    document.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", clearPressed);
    window.addEventListener("pointercancel", clearPressed);
    window.addEventListener("blur", clearPressed);
    return () => {
      clearPressed();
      document.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", clearPressed);
      window.removeEventListener("pointercancel", clearPressed);
      window.removeEventListener("blur", clearPressed);
    };
  }, []);
}

function isDisabledControl(control: HTMLElement): boolean {
  return control.matches(":disabled")
    || control.getAttribute("aria-disabled") === "true"
    || control.matches(".attachment-picker__button:has(input:disabled)");
}
