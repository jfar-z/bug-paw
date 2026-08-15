import { useRef, type KeyboardEvent } from "react";

interface QuestionStepTabsProps {
  count: number;
  activeIndex: number;
  onChange: (index: number) => void;
  label: string;
}

/** 提供问答卡片共用的逐题切换语义和键盘行为。 */
export function QuestionStepTabs({ count, activeIndex, onChange, label }: QuestionStepTabsProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  if (count <= 1) return null;

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number, offset: number) => {
    event.preventDefault();
    const nextIndex = (index + offset + count) % count;
    onChange(nextIndex);
    tabRefs.current[nextIndex]?.focus();
  };

  return <div className="question-step-tabs" role="tablist" aria-label={label}>
    {Array.from({ length: count }, (_, index) => <button
      key={index}
      ref={(element) => {
        tabRefs.current[index] = element;
      }}
      type="button"
      role="tab"
      aria-selected={index === activeIndex}
      tabIndex={index === activeIndex ? 0 : -1}
      onClick={() => onChange(index)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") move(event, index, -1);
        if (event.key === "ArrowRight") move(event, index, 1);
      }}
    >{index + 1}</button>)}
  </div>;
}
