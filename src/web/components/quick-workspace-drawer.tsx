import { X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { WorkspaceBrowser, type WorkspaceLocationRequest } from "./workspace-browser";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";

interface QuickWorkspaceDrawerProps {
  open: boolean;
  agentId?: string;
  agentName?: string;
  locationRequest?: WorkspaceLocationRequest;
  message?: string;
  swiping?: boolean;
  swipeTranslatePercent?: number;
  onClose(): void;
}

/** 在聊天工作台右侧复用当前 Agent 的资源管理能力。 */
export function QuickWorkspaceDrawer(props: QuickWorkspaceDrawerProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewCloseRequest, setPreviewCloseRequest] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  // 横向触摸由根手势处理器结算关闭，纵向滚动仍保持浏览器原生行为。
  const drawerStyle: CSSProperties = {
    touchAction: "pan-y",
    ...(props.swipeTranslatePercent === undefined ? {} : { transform: `translateX(${props.swipeTranslatePercent}%)` }),
  };
  useEffect(() => {
    if (!props.open) return;
    const onMobileBackRequest = (event: Event) => {
      event.preventDefault();
      if (previewOpen) setPreviewCloseRequest((current) => current + 1);
      else props.onClose();
    };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, onMobileBackRequest);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, onMobileBackRequest);
  }, [previewOpen, props.open, props.onClose]);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (props.open) drawerRef.current?.focus();
  }, [props.open]);
  return <>
    {props.open ? <button type="button" className="sidebar-scrim" style={{ display: "block", position: "fixed", inset: 0, zIndex: 29, border: 0, background: "rgba(8, 12, 9, 0.48)", backdropFilter: "blur(2px)" }} aria-label="点击遮罩关闭快捷资源管理" onClick={props.onClose} /> : null}
    <aside ref={drawerRef} className={`quick-workspace-drawer${props.open ? " is-open" : ""}${props.swiping || reduceMotion ? " is-swiping" : ""}`} style={drawerStyle} aria-label="快捷资源管理" aria-hidden={!props.open && !props.swiping} inert={!props.open && !props.swiping ? true : undefined} tabIndex={-1}>
      <header className="workspace-agent-navigation__header">
        <div><span>WORKSPACE · FILES</span><strong>快捷资源管理</strong><small>{props.agentName ? `${props.agentName} 的工作目录` : "当前 Agent 工作目录"}</small></div>
        <button type="button" className="icon-button" aria-label="关闭快捷资源管理" onClick={props.onClose}><X size={18} aria-hidden="true" /></button>
      </header>
      {props.message ? <p className="configuration-inline-error">{props.message}</p> : null}
      {props.open || props.swiping ? props.agentId ? <WorkspaceBrowser agentId={props.agentId} mode="quick" locationRequest={props.locationRequest} previewCloseRequest={previewCloseRequest} onPreviewOpenChange={setPreviewOpen} /> : <p className="quick-workspace-drawer__empty">当前没有可浏览的 Agent 工作目录。</p> : null}
    </aside>
  </>;
}
