import { Activity, Boxes, GitFork, LayoutDashboard, X } from "lucide-react";
import { SecondarySidebarHeader } from "../components/secondary-sidebar-header";
import type { AppRoute } from "../router";

export const AIGC_NAVIGATION_TOGGLE_EVENT = "pi-agent:toggle-aigc-navigation";

interface AigcWorkbenchSidebarProps {
  route: AppRoute;
  open: boolean;
  onClose: () => void;
  onNavigate: (route: AppRoute) => void;
}

/**
 * 展示 AIGC 工作台二级目录；渠道连接继续保留在配置中心。
 */
export function AigcWorkbenchSidebar({ route, open, onClose, onNavigate }: AigcWorkbenchSidebarProps) {
  const go = (nextRoute: AppRoute) => {
    onNavigate(nextRoute);
    onClose();
  };

  const interfaceActive = route.page === "aigc-interfaces" || route.page === "aigc-interface-detail";
  const taskActive = route.page === "aigc-tasks" || route.page === "aigc-task-detail";
  const workflowActive = route.page === "aigc-workflows" || route.page === "aigc-workflow-detail";

  return (
    <aside className={open ? "aigc-workbench-sidebar is-open" : "aigc-workbench-sidebar"}>
      <SecondarySidebarHeader
        className="aigc-workbench-sidebar__header"
        eyebrow="AIGC WORKBENCH"
        title="AIGC 工作台"
        actions={<button type="button" className="icon-button aigc-workbench-sidebar__close" aria-label="关闭 AIGC 导航" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>}
      />

      <nav className="aigc-workbench-nav" aria-label="AIGC 工作台导航">
        <p>工作台</p>
        <button
          type="button"
          className={route.page === "aigc-overview" ? "is-active" : undefined}
          aria-current={route.page === "aigc-overview" ? "page" : undefined}
          onClick={() => go({ page: "aigc-overview" })}
        >
          <LayoutDashboard size={17} aria-hidden="true" />
          <span>概览</span>
        </button>
        <button
          type="button"
          className={interfaceActive ? "is-active" : undefined}
          aria-current={interfaceActive ? "page" : undefined}
          onClick={() => go({ page: "aigc-interfaces" })}
        >
          <Boxes size={17} aria-hidden="true" />
          <span>接口</span>
        </button>
        <button
          type="button"
          className={taskActive ? "is-active" : undefined}
          aria-current={taskActive ? "page" : undefined}
          onClick={() => go({ page: "aigc-tasks" })}
        >
          <Activity size={17} aria-hidden="true" />
          <span>任务</span>
        </button>

        <p>编排</p>
        <button
          type="button"
          className={workflowActive ? "is-active" : undefined}
          aria-current={workflowActive ? "page" : undefined}
          onClick={() => go({ page: "aigc-workflows" })}
        >
          <GitFork size={17} aria-hidden="true" />
          <span>工作流</span>
        </button>
      </nav>

      <footer className="aigc-workbench-sidebar__footer">
        <span className="status-dot" aria-hidden="true" />
        <span><strong>AIGC 执行服务正常</strong><small>渠道状态见配置中心</small></span>
      </footer>
    </aside>
  );
}
