/** 知识库切片。 */
export interface KnowledgeTextChunk {
  index: number;
  text: string;
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
  if (options.maxLength <= 0 || options.overlap < 0 || options.overlap >= options.maxLength) {
    throw new RangeError("知识库切片长度配置无效");
  }
  const segments = text.match(/[^。！？\n]+[。！？]?|\n+/gu) ?? [];
  const chunks: KnowledgeTextChunk[] = [];
  let current = "";

  for (const segment of segments) {
    const normalized = segment.trim();
    if (!normalized) continue;
    if (current && current.length + normalized.length > options.maxLength) {
      chunks.push({ index: chunks.length, text: current });
      const overlapLength = Math.min(options.overlap, Math.max(0, options.maxLength - normalized.length));
      current = `${current.slice(-overlapLength)}${normalized}`;
    } else {
      current += normalized;
    }
    while (current.length > options.maxLength) {
      chunks.push({ index: chunks.length, text: current.slice(0, options.maxLength) });
      current = `${current.slice(options.maxLength - options.overlap)}`;
    }
  }
  if (current) chunks.push({ index: chunks.length, text: current });
  return chunks;
}
