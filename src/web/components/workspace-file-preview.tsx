import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkspaceEntry, WorkspaceTextPreview } from "../../shared/contracts";
import { api, workspaceFileUrl } from "../api";

interface WorkspaceFilePreviewProps {
  agentId: string;
  entry: WorkspaceEntry;
  onClose: () => void;
}

/**
 * 在资源管理页中按文件类型展示只读媒体或文本预览。
 */
export function WorkspaceFilePreview({ agentId, entry, onClose }: WorkspaceFilePreviewProps) {
  const [text, setText] = useState<WorkspaceTextPreview>();
  const [error, setError] = useState("");
  const mediaType = entry.mediaType ?? "application/octet-stream";
  const source = workspaceFileUrl(agentId, entry.path);

  useEffect(() => {
    if (mediaType.startsWith("image/") || mediaType.startsWith("video/") || mediaType.startsWith("audio/")) return;
    let active = true;
    setText(undefined);
    setError("");
    api.getWorkspaceText(agentId, entry.path).then((content) => {
      if (active) setText(content);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "当前文件无法预览");
    });
    return () => { active = false; };
  }, [agentId, entry.path, mediaType]);

  return <aside className="workspace-file-preview" aria-label={`${entry.name} 预览`}>
    <header><div><span>PREVIEW</span><strong>{entry.name}</strong></div><button type="button" className="icon-button" aria-label="关闭预览" onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
    <div className="workspace-file-preview__body">
      {mediaType.startsWith("image/") ? <img src={source} alt={entry.name} /> : null}
      {mediaType.startsWith("video/") ? <video src={source} controls /> : null}
      {mediaType.startsWith("audio/") ? <audio src={source} controls /> : null}
      {!mediaType.startsWith("image/") && !mediaType.startsWith("video/") && !mediaType.startsWith("audio/") ? <>{error ? <p className="configuration-inline-error">{error}</p> : text ? <><pre>{text.content}</pre>{text.truncated ? <p>仅展示前 512 KiB。</p> : null}</> : <p>正在读取文本预览…</p>}</> : null}
    </div>
    <a href={workspaceFileUrl(agentId, entry.path, true)} download={entry.name}><Download size={15} aria-hidden="true" />下载文件</a>
  </aside>;
}
