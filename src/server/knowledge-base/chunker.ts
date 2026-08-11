/** 知识库切片。 */
export interface KnowledgeTextChunk {
  index: number;
  text: string;
  page: number;
  section: string | null;
}

/** 解析器提供的单页正文。 */
export interface KnowledgeTextPage {
  page: number;
  text: string;
  section?: string | null;
}

/** 切片长度配置。 */
export interface KnowledgeChunkOptions {
  maxLength: number;
  overlap: number;
}

/**
 * 按句末或换行优先拆分文本，并为相邻片段保留有限上下文。
 *
 * @param text 已清理的知识库文本
 * @param options 最大长度和重叠长度
 */
export function chunkKnowledgeText(text: string, options: KnowledgeChunkOptions): KnowledgeTextChunk[] {
  return chunkKnowledgePages([{ page: 1, text }], options);
}

/** 按页独立切片，避免重叠内容跨越真实页边界。 */
export function chunkKnowledgePages(
  pages: KnowledgeTextPage[],
  options: KnowledgeChunkOptions,
): KnowledgeTextChunk[] {
  if (options.maxLength <= 0 || options.overlap < 0 || options.overlap >= options.maxLength) {
    throw new RangeError("知识库切片长度配置无效");
  }
  const chunks: KnowledgeTextChunk[] = [];

  for (const page of pages) {
    const pageChunks = chunkPage(page.text, options);
    for (const text of pageChunks) {
      chunks.push({
        index: chunks.length,
        text,
        page: page.page,
        section: page.section ?? null,
      });
    }
  }
  return chunks;
}

/** 使用现有句界策略拆分单页正文。 */
function chunkPage(text: string, options: KnowledgeChunkOptions): string[] {
  const segments = text.match(/[^。！？\n]+[。！？]?|\n+/gu) ?? [];
  const chunks: string[] = [];
  let current = "";

  for (const segment of segments) {
    const normalized = segment.trim();
    if (!normalized) continue;
    if (current && current.length + normalized.length > options.maxLength) {
      chunks.push(current);
      const overlapLength = Math.min(options.overlap, Math.max(0, options.maxLength - normalized.length));
      current = `${current.slice(-overlapLength)}${normalized}`;
    } else {
      current += normalized;
    }
    while (current.length > options.maxLength) {
      chunks.push(current.slice(0, options.maxLength));
      current = `${current.slice(options.maxLength - options.overlap)}`;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
