import { type FormEvent, type ReactNode, useState } from "react";

interface DangerDialogProps {
  title: string;
  confirmText: string;
  expectedText: string;
  children: ReactNode;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 对不可逆操作要求用户输入指定文本，降低误触风险。
 */
export function DangerDialog({ title, confirmText, expectedText, children, busy, onCancel, onConfirm }: DangerDialogProps) {
  const [confirmation, setConfirmation] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation === expectedText) onConfirm();
  }

  return (
    <div className="danger-dialog__backdrop" role="presentation">
      <form className="danger-dialog" role="dialog" aria-modal="true" aria-labelledby="danger-dialog-title" onSubmit={submit}>
        <h2 id="danger-dialog-title">{title}</h2>
        {children}
        <label>
          输入 <strong>{expectedText}</strong> 以确认
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </label>
        <footer>
          <button type="button" onClick={onCancel}>取消</button>
          <button type="submit" className="danger-action" disabled={busy || confirmation !== expectedText}>{confirmText}</button>
        </footer>
      </form>
    </div>
  );
}
