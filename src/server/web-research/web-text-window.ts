import { WebEvidenceError } from "./web-evidence-state";

/** 段落编号稳定，超长段落拆成可继续读取的窗口。 */
export function splitWebParagraphs(text: string): Array<{ paragraph: number; text: string }> {
  const chunks = text.split(/\n\s*\n|\n/u).map((part) => part.trim()).filter(Boolean)
    .flatMap((part) => Array.from({ length: Math.ceil(part.length / 1000) }, (_, index) => part.slice(index * 1000, (index + 1) * 1000)));
  return chunks.map((part, index) => ({ paragraph: index + 1, text: part }));
}

/** 按关键词或段落起点定位，返回有限上下文及继续位置。 */
export function selectWebWindow(text: string, input: { action?: "read" | "find"; query?: string | null; startParagraph?: number | null; maxCharacters: number }) {
  const paragraphs = splitWebParagraphs(text);
  const start = input.startParagraph ?? 1;
  if (!Number.isInteger(start) || start < 1 || (paragraphs.length > 0 && start > paragraphs.length)) {
    throw new WebEvidenceError("WEB_PARAGRAPH_OUT_OF_RANGE", "网页段落起点超出正文范围");
  }
  const needle = input.query?.trim().toLocaleLowerCase();
  if (input.action === "find" && !needle) throw new WebEvidenceError("WEB_INVALID_PARAMETERS", "查找网页时必须提供非空关键词");
  const matches = input.action === "find" ? paragraphs.filter((part) => part.paragraph >= start && part.text.toLocaleLowerCase().includes(needle!)) : [];
  const context = new Set(matches.flatMap((hit) => [hit.paragraph - 1, hit.paragraph, hit.paragraph + 1]));
  const candidates = input.action === "find"
    ? paragraphs.filter((part) => part.paragraph >= start && context.has(part.paragraph))
    : paragraphs.filter((part) => part.paragraph >= start);
  const selected: Array<{ paragraph: number; text: string }> = [];
  let remaining = input.maxCharacters;
  for (const part of candidates) {
    if (remaining <= 0) break;
    // 查找窗口优先保证命中本身可见，不让前一段上下文占满全部预算。
    if (input.action === "find" && !matches.some((hit) => hit.paragraph === part.paragraph)) {
      const nextHit = matches.find((hit) => hit.paragraph === part.paragraph + 1);
      if (nextHit && remaining < part.text.length + nextHit.text.length + 2) continue;
    }
    const value = part.text.slice(0, remaining);
    selected.push({ paragraph: part.paragraph, text: value });
    remaining -= value.length + 2;
  }
  const last = selected.at(-1)?.paragraph;
  const truncated = candidates.length > selected.length || selected.some((part) => part.text.length < paragraphs[part.paragraph - 1]!.text.length);
  return {
    text: selected.map((part) => part.text).join("\n\n"),
    paragraphs: selected,
    totalParagraphs: paragraphs.length,
    matchedParagraphs: matches.filter((part) => selected.some((item) => item.paragraph === part.paragraph)).map((part) => part.paragraph),
    totalMatches: matches.length,
    nextParagraph: truncated && last ? (selected.at(-1)!.text.length < paragraphs[last - 1]!.text.length ? last : candidates.find((part) => part.paragraph > last)?.paragraph ?? null) : null,
    truncated,
  };
}
