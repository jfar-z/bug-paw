import { PencilLine } from "lucide-react";
import { type FormEvent, useState } from "react";

interface ProviderRenameDialogProps {
  currentId: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (targetId: string) => void;
}

function validProviderId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value);
}

/**
 * 在应用内确认 Provider 改名及其引用迁移，避免使用浏览器原生提示框。
 */
export function ProviderRenameDialog({ currentId, busy, onCancel, onConfirm }: ProviderRenameDialogProps) {
  const [targetId, setTargetId] = useState(currentId);
  const normalizedId = targetId.trim();
  const isValid = validProviderId(normalizedId);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isValid && normalizedId !== currentId) onConfirm(normalizedId);
  }

  return (
    <div className="configuration-dialog-backdrop" role="presentation">
      <form className="configuration-dialog provider-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-rename-title" onSubmit={submit}>
        <header>
          <PencilLine size={20} aria-hidden="true" />
          <div>
            <h2 id="provider-rename-title">重命名 Provider</h2>
            <p>将同步迁移 API Key、Agent 默认模型和会话中的 Provider 引用。</p>
          </div>
        </header>
        <label className="provider-rename-dialog__field" htmlFor="provider-rename-id">
          新的 Provider ID
          <input id="provider-rename-id" aria-label="新的 Provider ID" autoFocus value={targetId} onChange={(event) => setTargetId(event.target.value)} />
        </label>
        <small className="provider-rename-dialog__help" role={targetId.trim() && !isValid ? "alert" : undefined}>
          {targetId.trim() && !isValid ? "ID 只能使用字母、数字、点、下划线或连字符，且不能以符号开头或结尾。" : "仅支持字母、数字、点、下划线和连字符。"}
        </small>
        <footer>
          <button type="button" className="configuration-secondary-action" disabled={busy} onClick={onCancel}>取消</button>
          <button type="submit" className="configuration-primary-action" disabled={busy || !isValid || normalizedId === currentId}>{busy ? "改名中…" : "确认改名"}</button>
        </footer>
      </form>
    </div>
  );
}
