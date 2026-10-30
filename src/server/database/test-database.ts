import { afterEach } from "vitest";
import { openDatabase, type Database } from "./database";
import { runMigrations } from "./migrator";

const testDatabases = new Set<Database>();
afterEach(() => {
  for (const database of testDatabases) database.close();
  testDatabases.clear();
});

/** 为单元测试创建完成 Migration 的内存数据库。 */
export function createTestDatabase(): Database {
  const database = openDatabase(":memory:");
  runMigrations(database);
  testDatabases.add(database);
  return database;
}
