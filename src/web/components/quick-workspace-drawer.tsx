import { FolderOpen, X } from "lucide-react";
import type { CSSProperties } from "react";
import { WorkspaceBrowser, type WorkspaceLocationRequest } from "./workspace-browser";

interface QuickWorkspaceDrawerProps {
  open: boolean;
  agentId?: string;
  agentName?: string;
  locationRequest?: WorkspaceLocationRequest;
  swiping?: boolean;
  swipeTranslatePercent?: number;
  onClose(): void;
}

/** 在聊天工作台右侧复用当前 Agent 的资源管理能力。 */
export function QuickWorkspaceDrawer(props: QuickWorkspaceDrawerProps) {
  const style: CSSProperties | undefined = props.swipeTranslatePercent === undefined
    ? undefined
    : { transform: `translateX(${props.swipeTranslatePercent}%)` };
  return <>
    {props.open ? <button type="button" className="quick-workspace-scrim" aria-label="点击遮罩关闭快捷资源管理" onClick={props.onClose} /> : null}
    <aside className={`quick-workspace-drawer${props.open ? " is-open" : ""}${props.swiping ? " is-swiping" : ""}`} style={style} aria-label="快捷资源管理">
      <header className="quick-workspace-drawer__header">
        <div><FolderOpen size={18} aria-hidden="true" /><span><strong>快捷资源管理</strong><small>{props.agentName ? `${props.agentName} 的工作目录` : "当前 Agent 工作目录"}</small></span></div>
        <button type="button" className="icon-button" aria-label="关闭快捷资源管理" onClick={props.onClose}><X size={18} aria-hidden="true" /></button>
      </header>
      {props.open || props.swiping ? props.agentId ? <WorkspaceBrowser agentId={props.agentId} mode="quick" locationRequest={props.locationRequest} /> : <p className="quick-workspace-drawer__empty">当前没有可浏览的 Agent 工作目录。</p> : null}
    </aside>
  </>;
}
