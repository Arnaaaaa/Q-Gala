import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { SqlDriver, SqlValue } from './db.ts';

/** node:sqlite driver, used for local development and the tests. */
export function nodeSqlite(path: string): SqlDriver {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
  const args = (a: SqlValue[]) => a as SQLInputValue[];
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...a) => ({ changes: Number(db.prepare(sql).run(...args(a)).changes) }),
    get: <T>(sql: string, ...a: SqlValue[]) => db.prepare(sql).get(...args(a)) as T | undefined,
    all: <T>(sql: string, ...a: SqlValue[]) => db.prepare(sql).all(...args(a)) as T[],
    close: () => db.close(),
  };
}
