interface MarkdownSegment {
  protected: boolean;
  value: string;
}

/**
 * 将常见的反斜杠数学定界符转换为 remark-math 支持的形式。
 * 代码围栏和行内代码作为受保护片段，不参与任何定界符替换。
 */
export function normalizeMathDelimiters(markdown: string): string {
  return splitProtectedMarkdown(markdown)
    .map((segment) => segment.protected ? segment.value : normalizeTextSegment(segment.value))
    .join("");
}

function splitProtectedMarkdown(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const lines = markdown.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let inlineTicks = 0;

  for (const line of lines) {
    const bareLine = line.replace(/\r?\n$/, "");
    if (fence) {
      appendSegment(segments, true, line);
      if (isClosingFence(bareLine, fence)) {
        fence = undefined;
      }
      continue;
    }

    if (inlineTicks === 0) {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(bareLine)?.[1];
      if (opening) {
        fence = { marker: opening[0] as "`" | "~", length: opening.length };
        appendSegment(segments, true, line);
        continue;
      }
    }

    let cursor = 0;
    while (cursor < line.length) {
      if (line[cursor] !== "`") {
        appendSegment(segments, inlineTicks > 0, line[cursor]);
        cursor += 1;
        continue;
      }
      const runLength = countRun(line, cursor, "`");
      appendSegment(segments, true, line.slice(cursor, cursor + runLength));
      if (inlineTicks === 0) {
        inlineTicks = runLength;
      } else if (runLength === inlineTicks) {
        inlineTicks = 0;
      }
      cursor += runLength;
    }
  }
  return segments;
}

function normalizeTextSegment(value: string): string {
  return value
    .replace(/(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g, (_match, expression: string) => `$$${expression}$$`)
    .replace(/(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g, (_match, expression: string) => `$${expression}$`);
}

function appendSegment(segments: MarkdownSegment[], protectedSegment: boolean, value: string): void {
  const last = segments.at(-1);
  if (last?.protected === protectedSegment) {
    last.value += value;
    return;
  }
  segments.push({ protected: protectedSegment, value });
}

function isClosingFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const trimmed = line.replace(/^ {0,3}/, "");
  const runLength = countRun(trimmed, 0, fence.marker);
  return runLength >= fence.length && trimmed.slice(runLength).trim() === "";
}

function countRun(value: string, start: number, character: string): number {
  let cursor = start;
  while (value[cursor] === character) {
    cursor += 1;
  }
  return cursor - start;
}
