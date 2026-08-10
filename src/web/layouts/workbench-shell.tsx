import { CalendarClock, ChevronDown, FolderOpen, LibraryBig, LogOut, Menu, MessageSquare, Settings2, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ProductMark } from "../components/product-mark";
import { ThemeSwitcher } from "../components/theme-switcher";
import { KNOWLEDGE_BASE_NAVIGATION_TOGGLE_EVENT, WORKBENCH_NAVIGATION_TOGGLE_EVENT, type AppRoute } from "../router";
import { WORKSPACE_AGENT_NAVIGATION_TOGGLE_EVENT } from "../components/workspace-agent-navigation";
import type { ThemePreference } from "../theme";
import { ConfigurationSidebar } from "./configuration-sidebar";

interface WorkbenchShellProps {
  route: AppRoute;
  theme: ThemePreference;
  children: ReactNode;
  onThemeChange: (theme: ThemePreference) => void;
  onNavigate: (route: AppRoute) => void;
  onLogout: () => void;
}

/**
 * 组合工作台主导航、配置目录与当前业务页面。
 */
export function WorkbenchShell({
  route,
  theme,
  children,
  onThemeChange,
  onNavigate,
  onLogout,
}: WorkbenchShellProps) {
  const [mainNavigationOpen, setMainNavigationOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const configurationRoute = isConfigurationRoute(route);
  const agentNavigationRoute = route.page === "workspace-resources" || route.page === "knowledge-base" || route.page === "scheduled-tasks";
  const knowledgeBaseRoute = route.page === "knowledge-base";
  const primaryNavigation = [
    { label: "会话", route: { page: "chat" } as AppRoute, icon: MessageSquare, active: route.page === "chat" },
    { label: "资源管理", route: { page: "workspace-resources" } as AppRoute, icon: FolderOpen, active: route.page === "workspace-resources" },
    { label: "知识库", route: { page: "knowledge-base" } as AppRoute, icon: LibraryBig, active: route.page === "knowledge-base" },
    { label: "定时任务", route: { page: "scheduled-tasks" } as AppRoute, icon: CalendarClock, active: route.page === "scheduled-tasks" },
    { label: "配置中心", route: { page: "configuration-overview" } as AppRoute, icon: Settings2, active: configurationRoute },
  ];

  useEffect(() => {
    const toggleNavigation = () => setMainNavigationOpen((current) => !current);
    window.addEventListener(WORKBENCH_NAVIGATION_TOGGLE_EVENT, toggleNavigation);
    return () => window.removeEventListener(WORKBENCH_NAVIGATION_TOGGLE_EVENT, toggleNavigation);
  }, []);

  const go = (nextRoute: AppRoute) => {
    onNavigate(nextRoute);
    setMainNavigationOpen(false);
  };

  const shellMode = configurationRoute ? "is-configuration" : agentNavigationRoute ? "is-workspace-resources" : "is-chat";

  return (
    <main className={`workbench-shell ${shellMode}`}>
      <header className="workbench-mobile-header">
        <button
          type="button"
          className="icon-button workbench-secondary-menu"
          aria-label={configurationRoute ? (configurationOpen ? "关闭配置导航" : "打开配置导航") : knowledgeBaseRoute ? "打开知识库列表" : agentNavigationRoute ? "打开 Agent 列表" : "当前工作台没有二级导航"}
          aria-expanded={configurationRoute ? configurationOpen : undefined}
          disabled={!configurationRoute && !agentNavigationRoute}
          onClick={() => {
            if (agentNavigationRoute) {
              setMainNavigationOpen(false);
              window.dispatchEvent(new Event(knowledgeBaseRoute ? KNOWLEDGE_BASE_NAVIGATION_TOGGLE_EVENT : WORKSPACE_AGENT_NAVIGATION_TOGGLE_EVENT));
              return;
            }
            if (!configurationRoute) return;
            setMainNavigationOpen(false);
            setConfigurationOpen((current) => !current);
          }}
        >
          <Menu size={19} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="chat-workbench-switcher"
          aria-label={mainNavigationOpen ? "关闭工作台导航" : "打开工作台导航"}
          aria-expanded={mainNavigationOpen}
          onClick={() => {
            setConfigurationOpen(false);
            setMainNavigationOpen((current) => !current);
          }}
        >
          <span>工作台</span><ChevronDown size={14} aria-hidden="true" />
        </button>
        <ProductMark />
      </header>

      {(mainNavigationOpen || configurationOpen) && (
        <button
          type="button"
          className="workbench-scrim"
          aria-label="关闭导航"
          onClick={() => {
            setMainNavigationOpen(false);
            setConfigurationOpen(false);
          }}
        />
      )}

      <aside className={mainNavigationOpen ? "workbench-rail is-open" : "workbench-rail"}>
        <div className="workbench-rail__brand"><ProductMark compact /></div>
        <nav className="workbench-main-nav" aria-label="工作台主导航">
          {primaryNavigation.map(({ label, route: nextRoute, icon: Icon, active }) => (
            <button
              key={label}
              type="button"
              className={active ? "is-active" : undefined}
              aria-current={active ? "page" : undefined}
              aria-label={label}
              title={label}
              onClick={() => go(nextRoute)}
            >
              <Icon size={20} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="workbench-rail__actions">
          <ThemeSwitcher value={theme} onChange={onThemeChange} compact />
          <button type="button" className="icon-button" aria-label="退出登录" title="退出登录" onClick={onLogout}>
            <LogOut size={18} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <div className="workbench-content">
        {configurationRoute ? (
          <div className="configuration-shell">
            <ConfigurationSidebar
              route={route}
              open={configurationOpen}
              onClose={() => setConfigurationOpen(false)}
              onNavigate={onNavigate}
            />
            <section className="configuration-content">
              {children}
            </section>
          </div>
        ) : children}
      </div>
    </main>
  );
}

/**
 * 判断路由是否属于配置中心，一级工作台预留页不展示配置二级目录。
 *
 * @param route 当前工作台路由
 */
function isConfigurationRoute(route: AppRoute): boolean {
  return [
    "configuration-overview",
    "agents",
    "providers",
    "pi-settings",
    "resources",
    "capabilities",
    "web-research",
    "tts",
    "knowledge-retrieval",
    "configuration-operations",
    "diagnostics",
    "agent-detail",
  ].includes(route.page);
}
