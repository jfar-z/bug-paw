import { openDatabase, type Database } from "./database";
import { runMigrations } from "./migrator";

/** 为单元测试创建完成 Migration 的内存数据库。 */
export function createTestDatabase(): Database {
  const database = openDatabase(":memory:");
  runMigrations(database);
  return database;
}
