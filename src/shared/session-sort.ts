export interface PinnableSessionSummary {
  id: string;
  modified: string;
  pinned?: boolean;
}

/** 返回置顶优先、组内按最近时间倒序排列的新数组。 */
export function sortSessionsPinnedFirst<T extends PinnableSessionSummary>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => {
    const pinOrder = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    if (pinOrder !== 0) return pinOrder;
    const modifiedOrder = right.modified.localeCompare(left.modified);
    return modifiedOrder !== 0 ? modifiedOrder : left.id.localeCompare(right.id);
  });
}
