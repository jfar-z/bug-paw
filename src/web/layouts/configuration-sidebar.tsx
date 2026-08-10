import {
  Activity,
  Bot,
  BrainCircuit,
  Boxes,
  Globe2,
  Volume2,
  History,
  KeyRound,
  LayoutDashboard,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { AppRoute } from "../router";

interface ConfigurationSidebarProps {
  route: AppRoute;
  open: boolean;
  onClose: () => void;
  onNavigate: (route: AppRoute) => void;
}

/**
 * 展示配置中心二级目录；尚未接入的模块明确标记为后续阶段。
 */
export function ConfigurationSidebar({ route, open, onClose, onNavigate }: ConfigurationSidebarProps) {
  const go = (nextRoute: AppRoute) => {
    onNavigate(nextRoute);
    onClose();
  };
  const agentActive = route.page === "agents" || route.page === "agent-detail";

  return (
    <aside className={open ? "configuration-sidebar is-open" : "configuration-sidebar"}>
      <header className="configuration-sidebar__header">
        <div>
          <span>SETTINGS</span>
          <strong>配置中心</strong>
        </div>
        <button type="button" className="icon-button configuration-sidebar__close" aria-label="关闭配置导航" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <nav className="configuration-nav" aria-label="配置中心导航">
        <p>工作区</p>
        <button
          type="button"
          className={route.page === "configuration-overview" ? "is-active" : undefined}
          aria-current={route.page === "configuration-overview" ? "page" : undefined}
          onClick={() => go({ page: "configuration-overview" })}
        >
          <LayoutDashboard size={17} aria-hidden="true" />
          <span>概览</span>
        </button>
        <button type="button" className={route.page === "pi-settings" ? "is-active" : undefined} aria-current={route.page === "pi-settings" ? "page" : undefined} onClick={() => go({ page: "pi-settings" })}>
          <SlidersHorizontal size={17} aria-hidden="true" /><span>运行设置</span>
        </button>
        <button type="button" className={route.page === "resources" ? "is-active" : undefined} aria-current={route.page === "resources" ? "page" : undefined} onClick={() => go({ page: "resources" })}>
          <Boxes size={17} aria-hidden="true" /><span>Skills 与扩展</span>
        </button>
        <button
          type="button"
          className={route.page === "providers" ? "is-active" : undefined}
          aria-current={route.page === "providers" ? "page" : undefined}
          onClick={() => go({ page: "providers" })}
        >
          <KeyRound size={17} aria-hidden="true" />
          <span>模型与凭证</span>
        </button>
        <button
          type="button"
          className={agentActive ? "is-active" : undefined}
          aria-current={agentActive ? "page" : undefined}
          onClick={() => go({ page: "agents" })}
        >
          <Bot size={17} aria-hidden="true" />
          <span>Agents</span>
        </button>

        <p>能力扩展</p>
        <button
          type="button"
          className={route.page === "web-research" ? "is-active" : undefined}
          aria-current={route.page === "web-research" ? "page" : undefined}
          onClick={() => go({ page: "web-research" })}
        >
          <Globe2 size={17} aria-hidden="true" />
          <span>联网搜索</span>
        </button>
        <button type="button" className={route.page === "tts" ? "is-active" : undefined} aria-current={route.page === "tts" ? "page" : undefined} onClick={() => go({ page: "tts" })}>
          <Volume2 size={17} aria-hidden="true" /><span>语音合成</span>
        </button>
        <button type="button" className={route.page === "knowledge-retrieval" ? "is-active" : undefined} aria-current={route.page === "knowledge-retrieval" ? "page" : undefined} onClick={() => go({ page: "knowledge-retrieval" })}>
          <BrainCircuit size={17} aria-hidden="true" /><span>语义检索</span>
        </button>

        <p>运行环境</p>
        <button type="button" className={route.page === "configuration-operations" ? "is-active" : undefined} aria-current={route.page === "configuration-operations" ? "page" : undefined} onClick={() => go({ page: "configuration-operations" })}><History size={17} aria-hidden="true" /><span>导入与变更</span></button>
        <button type="button" className={route.page === "diagnostics" ? "is-active" : undefined} aria-current={route.page === "diagnostics" ? "page" : undefined} onClick={() => go({ page: "diagnostics" })}><Activity size={17} aria-hidden="true" /><span>系统诊断</span></button>
      </nav>

      <footer className="configuration-sidebar__footer">
        <span className="status-dot" aria-hidden="true" />
        <span><strong>配置服务运行中</strong><small>核心配置为事实来源</small></span>
      </footer>
    </aside>
  );
}
