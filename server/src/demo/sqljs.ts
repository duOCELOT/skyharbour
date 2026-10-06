// A better-sqlite3-shaped facade over sql.js (SQLite compiled to wasm), so the
// server's domain modules — Ledger, MissionEngine, CrewMarket, … — run
// unchanged in the browser for the offline demo. Only the surface those
// modules use is implemented: exec, prepare().run/get/all, and transaction()
// with savepoint nesting (MissionEngine calls Ledger.transfer inside its own
// transactions, exactly as better-sqlite3 allows).
import type { Database as SqlJsDatabase, SqlValue } from 'sql.js';

type Params = SqlValue[];

export interface RunResult { changes: number; lastInsertRowid: number }

export class SqlJsStatement {
  constructor(private readonly db: SqlJsDatabase, private readonly sql: string) {}

  run(...params: Params): RunResult {
    this.db.run(this.sql, params);
    const changes = this.db.getRowsModified();
    const rowid = this.db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0];
    return { changes, lastInsertRowid: Number(rowid ?? 0) };
  }

  get(...params: Params): Record<string, SqlValue> | undefined {
    return this.rows(params, 1)[0];
  }

  all(...params: Params): Record<string, SqlValue>[] {
    return this.rows(params, Infinity);
  }

  private rows(params: Params, limit: number): Record<string, SqlValue>[] {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(params);
      const out: Record<string, SqlValue>[] = [];
      while (out.length < limit && stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }
}

export class SqlJsFacade {
  private depth = 0;

  constructor(readonly raw: SqlJsDatabase) {}

  exec(sql: string): this {
    this.raw.exec(sql);
    return this;
  }

  prepare(sql: string): SqlJsStatement {
    return new SqlJsStatement(this.raw, sql);
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const sp = `sp${this.depth}`;
      const outer = this.depth === 0;
      this.raw.exec(outer ? 'BEGIN' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
        return result;
      } catch (e) {
        this.depth--;
        this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      }
    };
  }
}
