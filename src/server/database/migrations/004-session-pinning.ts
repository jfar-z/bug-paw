/** 为 Session 增加 Web 自有的可空置顶时间。 */
export const sessionPinningMigration = {
  version: 4,
  sql: `
    ALTER TABLE sessions ADD COLUMN pinned_at TEXT;
  `,
} as const;
