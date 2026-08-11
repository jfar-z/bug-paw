import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface MessageCopyButtonProps {
  /** 已按消息角色规则提取出的纯文本。 */
  text: string;
}

/** 将单条消息纯文本写入系统剪贴板，并短暂显示成功反馈。 */
export function MessageCopyButton({ text }: MessageCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    if (!text || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // 浏览器拒绝剪贴板权限时保持原按钮，允许用户再次尝试。
      setCopied(false);
    }
  };

  const label = copied ? "已复制" : "复制消息";
  return (
    <button type="button" aria-label={label} title={label} onClick={() => void copy()}>
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
    </button>
  );
}
