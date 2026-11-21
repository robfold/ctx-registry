/**
 * The slice of the D1 API the Worker uses, on Node's built-in SQLite, with the real
 * migration applied. FTS5, triggers, bm25 and RETURNING all run for real.
 */
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly args: SQLInputValue[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new Statement(this.db, this.sql, args as SQLInputValue[]);
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[], success: true, meta: {} };
  }
  async first<T>(column?: string) {
    const row = this.db.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async run() {
    return { success: true, meta: { changes: Number(this.runSync().changes) } };
  }
  runSync() {
    return this.db.prepare(this.sql).run(...this.args);
  }
}

export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (stmts: Statement[]) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => {
          const r = s.runSync();
          return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
        });
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    raw: db,
  };
  return d1 as unknown as D1Database & { raw: DatabaseSync };
}
