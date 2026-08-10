import { File, LoaderCircle, Paperclip, X } from "lucide-react";
import type { ChangeEvent } from "react";
import type { WorkspaceFileSummary } from "../../shared/contracts";

export interface AttachmentUploadItem {
  localId: string;
  file: File;
  status: "uploading" | "uploaded" | "error" | "missing";
  workspaceFile?: WorkspaceFileSummary;
  error?: string;
}

interface AttachmentPickerProps {
  items: AttachmentUploadItem[];
  disabled?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  showButton?: boolean;
  onFilesSelected: (files: File[]) => void;
  onRemove: (localId: string) => void;
  onError: (message: string) => void;
}

/**
 * 负责附件选择边界与待发送状态展示，上传动作由对话页统一协调。
 */
export function AttachmentPicker({
  items,
  disabled,
  maxFiles = 5,
  maxFileSize = 100 * 1024 * 1024,
  showButton = true,
  onFilesSelected,
  onRemove,
  onError,
}: AttachmentPickerProps) {
  return (
    <div className="attachment-picker">
      {items.length > 0 && (
        <div className="attachment-picker__items" aria-label="待发送附件">
          {items.map((item) => (
            <div className={`attachment-upload-item is-${item.status}`} key={item.localId}>
              {item.status === "uploading" ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <File size={15} aria-hidden="true" />}
              <span><strong>{item.file.name}</strong><small>{statusText(item)}</small></span>
              <button type="button" aria-label={`移除 ${item.file.name}`} onClick={() => onRemove(item.localId)} disabled={disabled || item.status === "uploading"}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      {showButton ? <AttachmentPickerButton items={items} disabled={disabled} maxFiles={maxFiles} maxFileSize={maxFileSize} onFilesSelected={onFilesSelected} onError={onError} /> : null}
    </div>
  );
}

/** 仅渲染附件上传触发器，以便嵌入输入框的固定操作轨。 */
export function AttachmentPickerButton({
  items,
  disabled,
  maxFiles = 5,
  maxFileSize = 100 * 1024 * 1024,
  onFilesSelected,
  onError,
}: Omit<AttachmentPickerProps, "onRemove" | "showButton">) {
  function selectFiles(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) {
      return;
    }
    if (items.length + files.length > maxFiles) {
      onError(`单次消息最多添加 ${maxFiles} 个附件。`);
      return;
    }
    const oversized = files.find((file) => file.size > maxFileSize);
    if (oversized) {
      onError(`${oversized.name} 超过单文件大小限制。`);
      return;
    }
    onFilesSelected(files);
  }

  return (
    <label className="attachment-picker__button" title="添加图片、音视频或文件">
      <Paperclip size={17} aria-hidden="true" />
      <span className="visually-hidden">添加附件</span>
      <input type="file" aria-label="添加附件" multiple disabled={disabled} onChange={selectFiles} />
    </label>
  );
}

function statusText(item: AttachmentUploadItem): string {
  if (item.status === "uploading") {
    return "上传中";
  }
  if (item.status === "error") {
    return item.error ?? "上传失败";
  }
  if (item.status === "missing") return item.error ?? "历史附件已失效";
  return formatFileSize(item.file.size);
}

export function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
