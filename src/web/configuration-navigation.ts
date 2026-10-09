import type { AppRoute } from "./router";

/** 概览与侧栏使用同一组业务入口，避免新增能力后入口信息漂移。 */
export const configurationGroups: Array<{ title: string; entries: Array<{ key: string; title: string; description: string; route: AppRoute }> }> = [
  { title: "工作区", entries: [
    { key: "pi-settings", title: "运行设置", description: "全局声明、Agent 覆盖与执行策略。", route: { page: "pi-settings" } },
    { key: "resources", title: "Skills 与扩展", description: "资源目录、扩展包与注册工具。", route: { page: "resources" } },
    { key: "providers", title: "模型与凭证", description: "Provider、模型与访问凭证。", route: { page: "providers" } },
    { key: "agents", title: "Agents", description: "Agent 的模型、工具和工作环境。", route: { page: "agents" } },
  ] },
  { title: "能力扩展", entries: [
    { key: "web-research", title: "联网搜索", description: "搜索渠道与全局浏览策略。", route: { page: "web-research" } },
    { key: "browser-automation", title: "浏览器执行", description: "隔离浏览、交互权限与产物配额。", route: { page: "browser-automation" } },
    { key: "aigc-channels", title: "AIGC 渠道", description: "图像、视频与工作流连接配置。", route: { page: "aigc-channels" } },
    { key: "tts", title: "语音合成", description: "语音模型、音色及输出格式。", route: { page: "tts" } },
    { key: "knowledge-retrieval", title: "语义检索", description: "Embedding 服务与索引维护。", route: { page: "knowledge-retrieval" } },
  ] },
  { title: "运行环境", entries: [
    { key: "configuration-operations", title: "导入与变更", description: "安全导出、导入预览与历史恢复。", route: { page: "configuration-operations" } },
    { key: "diagnostics", title: "系统诊断", description: "检查具体异常与核心刷新影响。", route: { page: "diagnostics" } },
  ] },
];
