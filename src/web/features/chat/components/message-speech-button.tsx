import { Volume2, VolumeX } from "lucide-react";

interface MessageSpeechButtonProps {
  /** 是否正在合成或播放本条消息。 */
  active: boolean;

  /** 当前正文是否尚不可朗读。 */
  disabled: boolean;

  /** 切换朗读或停止状态。 */
  onToggle(): void;
}

/** 使用纯 SVG 图标切换单条 Agent 消息的朗读与停止状态。 */
export function MessageSpeechButton({ active, disabled, onToggle }: MessageSpeechButtonProps) {
  const label = active ? "停止朗读" : "朗读消息";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-playing={active || undefined}
      disabled={disabled}
      onClick={onToggle}
    >
      <Volume2 className="message-speech-button__speaker" size={16} aria-hidden="true" />
      {active ? <span className="message-speech-button__waves" aria-hidden="true">
        <span className="message-speech-button__wave" />
        <span className="message-speech-button__wave" />
      </span> : null}
      {active ? <VolumeX className="message-speech-button__stop" size={16} aria-hidden="true" /> : null}
    </button>
  );
}
