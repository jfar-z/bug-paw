import type { AgentTurn } from "./conversation-timeline";

const SPEAKABLE_CHARACTER = /[\p{L}\p{N}]/u;
const POTENTIAL_TABLE_ROW = /\s\|\s/;
const TABLE_DELIMITER_ROW = /^\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+$/;
const MIN_SEGMENT_LENGTH = 48;
const MAX_SEGMENT_LENGTH = 160;
const CLOSING_PUNCTUATION = new Set(["”", "’", '"', "'", "」", "』", "】", "》", "）", ")", "]", "}"]);
const SENTENCE_PUNCTUATION = new Set(["。", "！", "？", "；", ".", "!", "?"]);

/** 收集 Agent turn 中仅供用户阅读的 Markdown 正文。 */
export function agentTurnSpeechText(turn: AgentTurn): string {
  return turn.blocks
    .filter((block) => block.type === "markdown")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** 删除不应交给语音服务的 Markdown 结构，仅保留可见正文。 */
export function sanitizeMarkdownForSpeech(markdown: string): string {
  const withoutCompleteDisplayMath = markdown
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\\\[[\s\S]*?\\\]/g, "");
  const visibleLines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  let displayMath: "dollar" | "bracket" | undefined;

  for (const sourceLine of withoutCompleteDisplayMath.split("\n")) {
    const trimmedStart = sourceLine.trimStart();
    if (fence) {
      const closing = trimmedStart.match(/^(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }

    const opening = trimmedStart.match(/^(`{3,}|~{3,})/);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }

    if (displayMath) {
      continue;
    }
    if (trimmedStart.startsWith("$$")) {
      displayMath = "dollar";
      continue;
    }
    if (trimmedStart.startsWith("\\[")) {
      displayMath = "bracket";
      continue;
    }

    const trimmed = sourceLine.trim();
    if (!trimmed || isTableLine(trimmed)) {
      continue;
    }

    const cleaned = cleanInlineMarkdown(sourceLine).trim();
    if (cleaned) {
      visibleLines.push(cleaned);
    }
  }

  return visibleLines.join("\n");
}

/** 将 Markdown 转为适合顺序合成的稳定语音片段。 */
export function prepareSpeechSegments(markdown: string, completed: boolean): string[] {
  const sentences = splitNaturalSentences(sanitizeMarkdownForSpeech(markdown), completed)
    .filter((sentence) => SPEAKABLE_CHARACTER.test(sentence));
  return mergeShortSentences(sentences, completed);
}

/** 判断一行是否属于完整或正在形成的 Markdown 表格。 */
function isTableLine(line: string): boolean {
  return line.startsWith("|")
    || line.endsWith("|")
    || POTENTIAL_TABLE_ROW.test(line)
    || TABLE_DELIMITER_ROW.test(line);
}

/** 清理行内公式、链接目标和 Markdown 装饰符。 */
function cleanInlineMarkdown(line: string): string {
  return line
    .replace(/\\\([\s\S]*?\\\)/g, "")
    .replace(/(?<!\\)\$(?!\$)([^$\n，。！？]+?)(?<!\\)\$(?!\$)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/^\s*>+\s?/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/(?:\*\*|__|~~)(.*?)(?:\*\*|__|~~)/g, "$1")
    .replace(/(?:\*|_)(.*?)(?:\*|_)/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}

/** 按中英文句末标点切分，并在流式阶段丢弃未闭合尾句。 */
function splitNaturalSentences(text: string, completed: boolean): string[] {
  const sentences: string[] = [];
  let current = "";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n") {
      if (current && !current.endsWith(" ")) {
        current += " ";
      }
      continue;
    }
    current += character;
    if (!SENTENCE_PUNCTUATION.has(character)) {
      continue;
    }
    while (index + 1 < text.length && SENTENCE_PUNCTUATION.has(text[index + 1])) {
      current += text[index + 1];
      index += 1;
    }
    while (index + 1 < text.length && CLOSING_PUNCTUATION.has(text[index + 1])) {
      current += text[index + 1];
      index += 1;
    }
    const sentence = current.trim();
    if (sentence) {
      sentences.push(sentence);
    }
    current = "";
  }

  const tail = current.trim();
  if (completed && tail) {
    sentences.push(tail);
  }
  return sentences;
}

/** 合并相邻短句，减少小片段请求并保持已输出前缀稳定。 */
function mergeShortSentences(sentences: string[], completed: boolean): string[] {
  const segments: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current && current.length + sentence.length > MAX_SEGMENT_LENGTH) {
      segments.push(current);
      current = "";
    }
    current += sentence;
    if (current.length >= MIN_SEGMENT_LENGTH) {
      segments.push(current);
      current = "";
    }
  }

  if (completed && current) {
    segments.push(current);
  }
  return segments;
}
