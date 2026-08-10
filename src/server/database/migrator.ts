import type { Database } from "./database";
import { initialMigration } from "./migrations/001-initial";

const MIGRATIONS = [initialMigration] as const;

/** 按版本顺序执行未应用的数据库 Migration。 */
export function runMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  for (const migration of MIGRATIONS) {
    const applied = database.readOne<{ version: number }>(
      "SELECT version FROM schema_migrations WHERE version = ?",
      [migration.version],
    );
    if (applied) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      database.write(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        [migration.version, new Date().toISOString()],
      );
    });
  }
}
