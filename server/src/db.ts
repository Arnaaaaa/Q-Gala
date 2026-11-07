/** The few SQLite calls Db needs; implemented by node:sqlite (sqlite-node.ts) and Durable Object storage (worker.ts). */
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, ...args: SqlValue[]): { changes: number };
  get<T>(sql: string, ...args: SqlValue[]): T | undefined;
  all<T>(sql: string, ...args: SqlValue[]): T[];
  close?(): void;
}
export type SqlValue = string | number | null;

export type UserRow = {
  discord_id: string;
  name: string | null;
  name_norm: string | null;
  p0: number | null;
  bird_changed_at: number | null;
  session_id: string | null;
  is_test: number;
  banned: number;
  created_at: number;
  gd_best: number;
  rr_best: number;
  total_at: number | null;
  muted_until: number | null;
  lb_hidden: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  discord_id      TEXT PRIMARY KEY,
  name            TEXT,
  name_norm       TEXT UNIQUE,
  p0              INTEGER,
  bird_changed_at INTEGER,
  session_id      TEXT,
  is_test         INTEGER NOT NULL DEFAULT 0,
  banned          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS phrase_log (
  id         INTEGER PRIMARY KEY,
  discord_id TEXT NOT NULL,
  phrase_id  INTEGER NOT NULL,
  at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS migrations (
  name TEXT PRIMARY KEY,
  at   INTEGER NOT NULL
);`;

// Columns added after the first release; added in place on older database files.
const ADDED_COLUMNS: [string, string][] = [
  ['gd_best', 'INTEGER NOT NULL DEFAULT 0'],
  ['rr_best', 'INTEGER NOT NULL DEFAULT 0'],
  ['total_at', 'INTEGER'], // when the current total was first reached (leaderboard tie-break)
  ['muted_until', 'INTEGER'],
  ['lb_hidden', 'INTEGER NOT NULL DEFAULT 0'],
];

const ELIGIBLE = 'is_test = 0 AND lb_hidden = 0 AND name IS NOT NULL AND gd_best + rr_best > 0';

export type LeaderEntry = { name: string; p0: number; total: number };

export class Db {
  readonly sql: SqlDriver;

  constructor(sql: SqlDriver) {
    this.sql = sql;
    for (const stmt of SCHEMA.split(';')) if (stmt.trim()) this.sql.exec(stmt);
    const have = new Set(this.sql.all<{ name: string }>('PRAGMA table_info(users)').map((c) => c.name));
    for (const [col, def] of ADDED_COLUMNS) if (!have.has(col)) this.sql.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
    // Ravens and Robins points were multiplied by 5 on 8 Nov 2026; bring earlier bests onto the same scale.
    this.once('rr_points_x5', () => this.sql.run('UPDATE users SET rr_best = rr_best * 5'));
  }

  /** Runs a data migration exactly once per database. */
  private once(name: string, migrate: () => void): void {
    if (this.sql.get('SELECT 1 FROM migrations WHERE name = ?', name)) return;
    migrate();
    this.sql.run('INSERT INTO migrations (name, at) VALUES (?, ?)', name, Date.now());
  }

  /** Saves a Gate Dash score if it beats the stored best. Returns the best after saving. */
  recordGateDash(id: string, score: number, now = Date.now()): { best: number; newBest: boolean } {
    const r = this.sql.run('UPDATE users SET gd_best = ?, total_at = ? WHERE discord_id = ? AND gd_best < ?', score, now, id, score);
    return { best: this.getUser(id)?.gd_best ?? score, newBest: r.changes > 0 };
  }

  /** Saves a Ravens and Robins match score if it beats the stored best. */
  recordRavens(id: string, score: number, now = Date.now()): { best: number; newBest: boolean } {
    const r = this.sql.run('UPDATE users SET rr_best = ?, total_at = ? WHERE discord_id = ? AND rr_best < ?', score, now, id, score);
    return { best: this.getUser(id)?.rr_best ?? score, newBest: r.changes > 0 };
  }

  logPhrase(id: string, phraseId: number, now = Date.now()): void {
    this.sql.run('INSERT INTO phrase_log (discord_id, phrase_id, at) VALUES (?, ?, ?)', id, phraseId, now);
  }

  /** Highest totals first; ties go to whoever reached the total first. */
  topTotals(limit: number): LeaderEntry[] {
    return this.sql.all(`SELECT name, p0, gd_best + rr_best AS total FROM users WHERE ${ELIGIBLE} ORDER BY total DESC, total_at ASC, discord_id LIMIT ?`, limit) as LeaderEntry[];
  }

  /** The player's rank, or null if they have no score or are not on the board. */
  rankOf(id: string): { rank: number; total: number } | null {
    const u = this.sql.get(`SELECT gd_best + rr_best AS total, total_at FROM users WHERE discord_id = ? AND ${ELIGIBLE}`, id) as
      | { total: number; total_at: number | null }
      | undefined;
    if (!u) return null;
    const ahead = this.sql.get(
      `SELECT COUNT(*) AS n FROM users WHERE ${ELIGIBLE} AND discord_id != ?
           AND (gd_best + rr_best > ? OR (gd_best + rr_best = ? AND (total_at < ? OR (total_at = ? AND discord_id < ?))))`,
      id, u.total, u.total, u.total_at ?? 0, u.total_at ?? 0, id) as { n: number };
    return { rank: ahead.n + 1, total: u.total };
  }

  countRanked(): number {
    return (this.sql.get(`SELECT COUNT(*) AS n FROM users WHERE ${ELIGIBLE}`) as { n: number }).n;
  }

  getUser(id: string): UserRow | undefined {
    return this.sql.get('SELECT * FROM users WHERE discord_id = ?', id) as UserRow | undefined;
  }

  /** Records a login and makes `sessionId` the only valid session for this user. */
  upsertLogin(id: string, sessionId: string, isTest: boolean, now = Date.now()): void {
    this.sql.run(
      `INSERT INTO users (discord_id, session_id, is_test, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(discord_id) DO UPDATE SET session_id = excluded.session_id, is_test = excluded.is_test`,
      id, sessionId, isTest ? 1 : 0, now);
  }

  /** Atomic: the UNIQUE index on name_norm guarantees one winner per name. */
  claimName(id: string, name: string, norm: string): 'ok' | 'taken' | 'already' {
    try {
      const r = this.sql.run('UPDATE users SET name = ?, name_norm = ? WHERE discord_id = ? AND name IS NULL', name, norm, id);
      return r.changes > 0 ? 'ok' : 'already';
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) return 'taken';
      throw e;
    }
  }

  setBird(id: string, p0: number, now = Date.now()): void {
    this.sql.run('UPDATE users SET p0 = ?, bird_changed_at = ? WHERE discord_id = ?', p0, now, id);
  }

  close(): void {
    this.sql.close?.();
  }
}
