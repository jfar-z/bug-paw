import { ChevronLeft, Download, Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { WorkspaceEntry, WorkspaceTextPreview } from "../../shared/contracts";
import { api, workspaceFileUrl } from "../api";
import { useApiTask } from "../api-task-provider";

interface WorkspaceFilePreviewProps {
  agentId: string;
  entry: WorkspaceEntry;
  mode: "side" | "overlay";
  onClose: () => void;
}

/**
 * 在资源管理页中按文件类型展示只读媒体或文本预览。
 */
export function WorkspaceFilePreview({ agentId, entry, mode, onClose }: WorkspaceFilePreviewProps) {
  const { runApiTask } = useApiTask();
  const [text, setText] = useState<WorkspaceTextPreview>();
  const [error, setError] = useState("");
  const [htmlView, setHtmlView] = useState<"page" | "source">("page");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const previewRef = useRef<HTMLElement>(null);
  const mediaType = entry.mediaType ?? "application/octet-stream";
  const source = workspaceFileUrl(agentId, entry.path);
  const isHtml = mediaType === "text/html" || entry.name.toLowerCase().endsWith(".html");
  const isMedia = mediaType.startsWith("image/") || mediaType.startsWith("video/") || mediaType.startsWith("audio/");
  // 预览层及其内容区均可能成为滚动边界，需要继续支持横划返回资源列表。
  const previewStyle: CSSProperties | undefined = mode === "overlay"
    ? { width: "100%", minWidth: 0, height: "100%", zIndex: 2, touchAction: "pan-y" }
    : undefined;

  useEffect(() => {
    if (isMedia || (isHtml && htmlView === "page")) return;
    let active = true;
    setText(undefined);
    setError("");
    api.getWorkspaceText(agentId, entry.path).then((content) => {
      if (active) setText(content);
    }).catch(async (reason) => {
      if (!active) return;
      await runApiTask(async () => { throw reason; }, {
        operation: "预览工作区文件",
        expected: {
          TEXT_PREVIEW_UNAVAILABLE: (error) => setError(error.message),
          FILE_NOT_FOUND: (error) => setError(error.message),
          INVALID_PATH: (error) => setError(error.message),
        },
      });
    });
    return () => { active = false; };
  }, [agentId, entry.path, htmlView, isHtml, isMedia, runApiTask]);

  useEffect(() => {
    setHtmlView("page");
  }, [entry.path]);

  useEffect(() => {
    const updateFullscreenState = () => setIsFullscreen(document.fullscreenElement === previewRef.current);
    updateFullscreenState();
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () => document.removeEventListener("fullscreenchange", updateFullscreenState);
  }, []);

  const toggleFullscreen = () => {
    if (!previewRef.current) return;
    const operation = document.fullscreenElement === previewRef.current
      ? document.exitFullscreen?.()
      : previewRef.current.requestFullscreen?.();
    // 浏览器可能因用户权限或运行环境拒绝全屏，普通预览仍需保持可用。
    void operation?.catch(() => undefined);
  };

  return <aside ref={previewRef} className={`workspace-file-preview workspace-file-preview--${mode}`} style={previewStyle} aria-label={`${entry.name} 预览`}>
    <header><div className="workspace-file-preview__heading"><span>PREVIEW</span><strong>{entry.name}</strong></div><div className="workspace-file-preview__controls">{isHtml ? <button type="button" className="workspace-file-preview__view-button" aria-label={htmlView === "page" ? "查看源码" : "查看页面"} onClick={() => setHtmlView((current) => current === "page" ? "source" : "page")}>{htmlView === "page" ? "源码" : "页面"}</button> : null}<button type="button" className="icon-button" aria-label={isFullscreen ? "退出全屏预览" : "全屏预览"} onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 size={18} aria-hidden="true" /> : <Maximize2 size={18} aria-hidden="true" />}</button><button type="button" className="icon-button" aria-label={mode === "overlay" ? "返回文件列表" : "关闭预览"} onClick={onClose}>{mode === "overlay" ? <ChevronLeft size={18} aria-hidden="true" /> : <X size={18} aria-hidden="true" />}</button></div></header>
    <div className="workspace-file-preview__body" style={mode === "overlay" ? { touchAction: "pan-y" } : undefined}>
      {mediaType.startsWith("image/") ? <img src={source} alt={entry.name} /> : null}
      {mediaType.startsWith("video/") ? <video src={source} controls /> : null}
      {mediaType.startsWith("audio/") ? <audio src={source} controls /> : null}
      {isHtml && htmlView === "page" ? <iframe className="workspace-file-preview__html-frame" title={`${entry.name} 页面预览`} src={source} sandbox="allow-scripts" /> : null}
      {!isMedia && (!isHtml || htmlView === "source") ? <>{error ? <p className="configuration-inline-error">{error}</p> : text ? <><pre>{text.content}</pre>{text.truncated ? <p>仅展示前 512 KiB。</p> : null}</> : <p>正在读取文本预览…</p>}</> : null}
    </div>
    <a href={workspaceFileUrl(agentId, entry.path, true)} download={entry.name}><Download size={15} aria-hidden="true" />下载文件</a>
  </aside>;
}
