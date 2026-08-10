import { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface DatabaseWriteResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** SQLite 的最小受控接口，业务 SQL 只能由 Repository 通过该接口执行。 */
export interface Database {
  read<T extends Record<string, unknown>>(sql: string, parameters?: readonly SqlValue[]): T[];
  readOne<T extends Record<string, unknown>>(sql: string, parameters?: readonly SqlValue[]): T | undefined;
  write(sql: string, parameters?: readonly SqlValue[]): DatabaseWriteResult;
  exec(sql: string): void;
  transaction<T>(operation: () => T): T;
  checkpoint(): void;
  close(): void;
}

/** 打开启用外键、WAL 和有界锁等待的 BugPaw 数据库。 */
export function openDatabase(path: string): Database {
  const connection = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA journal_mode = WAL");
  connection.exec("PRAGMA busy_timeout = 5000");
  connection.exec("PRAGMA synchronous = NORMAL");
  let transactionDepth = 0;
  let closed = false;

  return {
    read<T extends Record<string, unknown>>(sql: string, parameters: readonly SqlValue[] = []): T[] {
      assertOpen();
      return connection.prepare(sql).all(...parameters) as T[];
    },
    readOne<T extends Record<string, unknown>>(sql: string, parameters: readonly SqlValue[] = []): T | undefined {
      assertOpen();
      return connection.prepare(sql).get(...parameters) as T | undefined;
    },
    write(sql: string, parameters: readonly SqlValue[] = []): DatabaseWriteResult {
      assertOpen();
      const result = connection.prepare(sql).run(...parameters);
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    },
    exec(sql: string): void {
      assertOpen();
      connection.exec(sql);
    },
    transaction<T>(operation: () => T): T {
      assertOpen();
      if (transactionDepth > 0) {
        return operation();
      }
      connection.exec("BEGIN IMMEDIATE");
      transactionDepth += 1;
      try {
        const result = operation();
        connection.exec("COMMIT");
        return result;
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
    checkpoint(): void {
      assertOpen();
      connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    close(): void {
      if (closed) return;
      closed = true;
      connection.close();
    },
  };

  function assertOpen(): void {
    if (closed) throw new Error("数据库连接已经关闭");
  }
}
