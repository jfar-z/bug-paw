import type { WorkspaceFileRef, WorkspaceFileSummary } from "../../shared/contracts";
import { MediaAttachment } from "./media-attachment";

interface MessageAttachmentsProps {
  files: Array<WorkspaceFileRef | WorkspaceFileSummary>;
  agentId: string;
  onResolved: (summary: WorkspaceFileSummary) => void;
  onPreview: (summary: WorkspaceFileSummary) => void;
}

/**
 * 上报单条消息附件的已解析元数据和预览请求，由会话页统一维护图片画廊。
 */
export function MessageAttachments({ files, agentId, onResolved, onPreview }: MessageAttachmentsProps) {
  return (
    <div className="message-attachments">
      {files.map((file) => (
        <MediaAttachment
          key={file.path}
          file={file}
          agentId={agentId}
          onResolved={onResolved}
          onPreview={onPreview}
        />
      ))}
    </div>
  );
}
