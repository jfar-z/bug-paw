import { BrainCircuit, Check, ChevronDown, CircleOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { THINKING_LEVELS, type ThinkingLevel } from "../../shared/configuration-contracts";
import type { ModelSummary } from "../api";

interface ComposerSessionControlsProps {
  models: readonly ModelSummary[];
  selectedModel?: ModelSummary;
  thinkingLevel: ThinkingLevel;
  disabled?: boolean;
  onThinkingLevelChange(thinkingLevel: ThinkingLevel): void;
  onModelChange(model: ModelSummary): void;
}

/** 承载输入区会话级思考深度与模型选择。 */
export function ComposerSessionControls({
  models,
  selectedModel,
  thinkingLevel,
  disabled = false,
  onThinkingLevelChange,
  onModelChange,
}: ComposerSessionControlsProps) {
  const [openMenu, setOpenMenu] = useState<"thinking" | "model">();
  const rootRef = useRef<HTMLDivElement>(null);
  const thinkingLevels = selectedModel?.thinkingLevels ?? [...THINKING_LEVELS];
  const thinkingUnavailable = thinkingLevels.length <= 1;
  const thinkingLabel = thinkingLevelLabels[thinkingLevel];

  useEffect(() => {
    if (!openMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(undefined);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  const thinkingAriaLabel = thinkingUnavailable
    ? `思考深度：${thinkingLabel}；当前模型不支持调整`
    : `思考深度：${thinkingLabel}`;

  return <div className="composer-session-controls" ref={rootRef}>
    <div className="composer-session-control">
      <button
        type="button"
        className="composer-thinking-trigger"
        aria-label={thinkingAriaLabel}
        aria-expanded={openMenu === "thinking"}
        aria-haspopup="listbox"
        title={thinkingAriaLabel}
        disabled={disabled || thinkingUnavailable}
        onClick={() => setOpenMenu((current) => current === "thinking" ? undefined : "thinking")}
      >
        <BrainCircuit size={18} aria-hidden="true" />
      </button>
      {openMenu === "thinking" ? <div className="composer-control-menu composer-thinking-menu" role="listbox" aria-label="思考深度">
        {thinkingLevels.map((level) => <button
          key={level}
          type="button"
          role="option"
          aria-label={`${thinkingLevelLabels[level]} ${level}`}
          aria-selected={level === thinkingLevel}
          onClick={() => {
            onThinkingLevelChange(level);
            setOpenMenu(undefined);
          }}
        >
          {level === "off" ? <CircleOff size={15} aria-hidden="true" /> : <BrainCircuit size={15} aria-hidden="true" />}
          <span>{thinkingLevelLabels[level]}</span>
          <small>{level}</small>
          {level === thinkingLevel ? <Check size={15} aria-hidden="true" /> : null}
        </button>)}
      </div> : null}
    </div>

    <div className="composer-session-control composer-model-control">
      <button
        type="button"
        className="composer-model-trigger"
        aria-label={`切换模型，当前 ${selectedModel?.name ?? "未选择"}`}
        aria-expanded={openMenu === "model"}
        aria-haspopup="listbox"
        title={selectedModel?.name ?? "选择模型"}
        disabled={disabled || models.length === 0}
        onClick={() => setOpenMenu((current) => current === "model" ? undefined : "model")}
      >
        <span>{selectedModel?.name ?? "选择模型"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {openMenu === "model" ? <div className="composer-control-menu composer-model-menu" role="listbox" aria-label="可用模型">
        {models.map((model) => {
          const selected = sameModel(model, selectedModel);
          return <button
            key={`${model.provider}:${model.id}`}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => {
              onModelChange(model);
              setOpenMenu(undefined);
            }}
          >
            <span><strong>{model.name}</strong><small>{model.provider} · {model.id}</small></span>
            {selected ? <Check size={15} aria-hidden="true" /> : null}
          </button>;
        })}
      </div> : null}
    </div>
  </div>;
}

const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};

function sameModel(left: ModelSummary, right?: ModelSummary): boolean {
  return left.provider === right?.provider && left.id === right.id;
}
